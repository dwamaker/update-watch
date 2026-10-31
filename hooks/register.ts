import type { EngineInterface, Register } from 'claude-code'

type Result = { at: number; found: string[]; problems: string[] }

const CHECK_EVERY_MS = 12 * 60 * 60 * 1000
// The official marketplace updates itself; the directory one is claude.ai's.
const SKIP_MARKETPLACES = new Set(['claude-plugins-official', 'anthropic-plugin-directory'])
// Commits that only touch these don't count as a plugin change.
const NOISE = /(^|\/)(README[^/]*|CHANGELOG[^/]*|LICENSE[^/]*|SECURITY[^/]*|docs\/.*|tests?\/.*|\.github\/.*|benchmarks?\/.*)$/i
// Skills copied by hand: no lock file records them, so their files are compared
// with upstream one by one. `local` is relative to the home folder.
const MANUAL = [
  { repo: 'Jahrome907/minecraft-agent-skills', remote: '.claude/skills', local: '.claude/skills', isGroup: true },
  { repo: 'cloudflare/security-audit-skill', remote: 'skills/security-audit', local: '.claude/skills/security-audit', isGroup: false },
  { repo: 'NVIDIA/SkillSpector', remote: 'skills/skill-inspector', local: '.claude/skills/skill-inspector', isGroup: false },
]

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')

// Git's blob id for these bytes, the id GitHub's tree listing carries.
export async function blobId(bytes: Uint8Array) {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`)
  const all = new Uint8Array(head.length + bytes.length)
  all.set(head)
  all.set(bytes, head.length)
  return hex(await crypto.subtle.digest('SHA-1', all))
}

// Windows checkouts may hold CRLF where the repo stores LF.
export function withoutCr(bytes: Uint8Array) {
  if (bytes.includes(0)) return bytes
  return bytes.filter((b, i) => !(b === 13 && bytes[i + 1] === 10))
}

async function check($: EngineInterface): Promise<Result> {
  const found: string[] = []
  const problems: string[] = []
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
  const readJson = async (path: string) => JSON.parse(await $.fs.read(`${home}/${path}`))
  // A machine without this file simply has nothing of that kind to check.
  const optionalJson = async (path: string) => ((await $.fs.exists(`${home}/${path}`)) ? readJson(path) : undefined)
  const github = async (path: string) => {
    const res = await $.http.fetch(`https://api.github.com/${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'update-watch' },
    })
    if (res.status === 403 || res.status === 429) throw new Error('GitHub API 한도 초과, 다음 확인 때 다시 시도')
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${path}`)
    return JSON.parse(res.text)
  }
  const raw = async (repo: string, path: string) => {
    const res = await $.http.fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${path}`)
    if (!res.ok) throw new Error(`${repo}/${path} ${res.status}`)
    return JSON.parse(res.text)
  }
  const trees = new Map<string, Promise<Map<string, string>>>()
  const tree = (repo: string) => {
    if (!trees.has(repo)) {
      trees.set(repo, github(`repos/${repo}/git/trees/HEAD?recursive=1`).then(
        t => new Map((t.tree as { path: string; sha: string }[]).map(n => [n.path, n.sha])),
      ))
    }
    return trees.get(repo)!
  }
  const attempt = async (what: string, work: () => Promise<void>) => {
    try {
      await work()
    } catch (err) {
      problems.push(`${what}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Plugins: a new version, or files changed under the same version (only a
  // reinstall picks those up; `claude plugin update` looks at the version).
  await attempt('plugins', async () => {
    const installed = (await optionalJson('.claude/plugins/installed_plugins.json'))?.plugins ?? {}
    const known = (await optionalJson('.claude/plugins/known_marketplaces.json')) ?? {}
    await Promise.all(Object.entries(installed).map(([key, entries]) => attempt(key, async () => {
      const [name = '', market = ''] = key.split('@')
      const entry = (entries as { version: string; gitCommitSha?: string }[])[0]
      const source = known[market]?.source
      if (!entry || SKIP_MARKETPLACES.has(market) || source?.source !== 'github') return
      const listing = await raw(source.repo, '.claude-plugin/marketplace.json')
      const plugin = listing.plugins.find((p: { name: string }) => p.name === name)
      // shortcut: plugins whose source is another repo are skipped; check them
      // against that repo if one gets installed.
      if (!plugin || typeof plugin.source !== 'string') return
      const dir = plugin.source.replace(/^\.\/?/, '').replace(/\/$/, '')
      // Claude Code reads the version from plugin.json first, so do the same.
      const manifest = await raw(source.repo, `${dir ? `${dir}/` : ''}.claude-plugin/plugin.json`).catch(() => ({}))
      const version = manifest.version ?? plugin.version
      if (version && version !== entry.version) {
        found.push(`${name} ${entry.version} → ${version}`)
        return
      }
      if (!entry.gitCommitSha) return
      const diff = await github(`repos/${source.repo}/compare/${entry.gitCommitSha}...HEAD`)
      const changed = (diff.files ?? [])
        .map((f: { filename: string }) => f.filename)
        .filter((f: string) => (!dir || f.startsWith(`${dir}/`)) && !NOISE.test(dir ? f.slice(dir.length + 1) : f))
      if (changed.length > 0) found.push(`${name} ${entry.version} (버전 같음, 파일 ${changed.length}개 바뀜: 재설치 필요)`)
    })))
  })

  // Skills from `npx skills`: the lock keeps each folder's tree id.
  await attempt('npx skills', async () => {
    const lock = ((await optionalJson('.agents/.skill-lock.json'))?.skills ?? {}) as Record<string, { source: string; skillPath: string; skillFolderHash: string }>
    await Promise.all(Object.entries(lock).map(([name, s]) => attempt(name, async () => {
      const remote = (await tree(s.source)).get(s.skillPath.replace(/\/?SKILL\.md$/, ''))
      if (!remote) throw new Error(`upstream에 ${s.skillPath} 없음`)
      if (remote !== s.skillFolderHash) found.push(name)
    })))
  })

  // Hand-copied skills: every upstream file must match the local copy.
  await Promise.all(MANUAL.map(m => attempt(m.repo, async () => {
    const stale = new Set<string>()
    const present = new Map<string, boolean>()
    const entries =[...(await tree(m.repo))].filter(([path]) => path.startsWith(`${m.remote}/`))
    if (entries.length === 0) throw new Error(`upstream에 ${m.remote} 경로 없음`)
    // shortcut: only upstream-to-local; a file deleted upstream but left
    // locally goes unreported. List the local folder too if that ever matters.
    for (const [path, sha] of entries) {
      const rel = path.slice(m.remote.length + 1)
      const skill = (m.isGroup ? rel.split('/')[0] : m.local.split('/').pop()) ?? rel
      if (m.isGroup && !rel.includes('/')) continue
      if (stale.has(skill)) continue
      // Only skills this machine has installed are compared.
      if (!present.has(skill)) present.set(skill, await $.fs.exists(m.isGroup ? `${home}/${m.local}/${skill}` : `${home}/${m.local}`))
      if (!present.get(skill)) continue
      const local = `${home}/${m.local}/${rel}`
      // One unreadable file (locked, over the 4 MiB read limit) costs only itself.
      await attempt(local, async () => {
        if (!(await $.fs.exists(local))) {
          stale.add(skill)
          return
        }
        // Upstream folders show up as tree entries; only files are compared.
        if ((await $.fs.stat(local)).kind === 'dir') return
        const { base64 } = await $.fs.read(local, { as: 'bytes' })
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
        if ((await blobId(bytes)) !== sha && (await blobId(withoutCr(bytes))) !== sha) stale.add(skill)
      })
    }
    found.push(...stale)
  })))

  // REA: the registration pins a version; npm says what's latest.
  await attempt('REA', async () => {
    const args: string[] = (await readJson('.claude.json')).mcpServers?.rea?.args ?? []
    const current = /rea-agents@(\d[\w.-]*)/.exec(args.join(' '))?.[1]
    if (!current) return
    const res = await $.http.fetch('https://registry.npmjs.org/rea-agents/latest')
    if (!res.ok) throw new Error(`npm ${res.status}`)
    const latest = JSON.parse(res.text)
    if (latest.version && latest.version !== current) found.push(`REA ${current} → ${latest.version} (Node ${latest.engines?.node ?? '?'})`)
  })

  return { at: await $.clock.now(), found: found.sort(), problems }
}

function report(r: Result) {
  const lines = r.found.length > 0 ? ['업데이트 있음:', ...r.found.map(f => `  - ${f}`)] : ['모두 최신이에요.']
  if (r.problems.length > 0) lines.push('확인 못 한 것:', ...r.problems.map(p => `  - ${p}`))
  lines.push('적용은 하지 않았어요. 검토 후 직접 올려주세요.')
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'updates',
      description: '플러그인·스킬·REA 업데이트를 지금 확인 (적용은 안 함)',
    })
    // A few seconds in, so the check never slows the session's start.
    $.clock.after(5000, () => {
      void (async () => {
        const last = (await $.store.get('result')) as Result | undefined
        if (last && (await $.clock.now()) - last.at < CHECK_EVERY_MS) return
        const r = await check($)
        // A failed check isn't cached, or an outage would hide updates for 12 h.
        if (r.problems.length === 0) await $.store.set('result', r)
        if (r.found.length > 0) {
          const shown = r.found.slice(0, 3).join(', ') + (r.found.length > 3 ? ` 외 ${r.found.length - 3}건` : '')
          $.ui.toast(`업데이트 ${r.found.length}건: ${shown} · /updates`, { timeoutMs: 10000 })
        } else if (r.problems.length > 0) {
          $.ui.toast(`업데이트 확인 일부 실패 (${r.problems.length}건) · /updates`, { timeoutMs: 6000 })
        }
      })().catch(err => $.ui.toast(`update-watch 실패: ${err instanceof Error ? err.message : String(err)}`))
    })
    return next(e)
  })

  on('command.run', { command: 'updates' }, async $ => {
    const r = await check($)
    if (r.problems.length === 0) await $.store.set('result', r)
    return { text: report(r) }
  })
}
