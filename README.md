# update-watch

Claude Code mod that checks for upstream updates and shows a short toast. It never installs or changes anything.

What it checks, at session start (at most every 12 hours) and on `/updates`:

- **Plugins** from GitHub marketplaces: a new version, or files changed under the same version (a change only a reinstall picks up). README, docs and test changes are ignored. The official marketplace is skipped because it updates itself.
- **Skills installed with `npx skills`**: the folder hash in `~/.agents/.skill-lock.json` against GitHub.
- **Hand-copied skills** listed in `MANUAL` in `hooks/register.ts`, compared file by file. Only skills present on the machine are checked; edit the list for your own.
- **REA**: the version pinned in the `rea` MCP registration against npm's latest.

A failed check (network, GitHub rate limit) is not cached, so it runs again next session. GitHub is called without a token, about 16 API calls per check.

## Install

At the prompt of a terminal session:

```
/plugin install update-watch --marketplace dwamaker/update-watch
```

Answer `y` to add the marketplace, then pick the user scope.

From a shell:

```
claude plugin install update-watch --marketplace dwamaker/update-watch
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `dwamaker/update-watch`, then Add plugin.
