import { expect, test } from 'claude-code/testing'

import { blobId, semver, withoutCr } from '../hooks/register'

const bytes = (s: string) => new TextEncoder().encode(s)

test('blob ids match git hash-object, CRLF folded only in text', async () => {
  // `printf 'hello\n' | git hash-object --stdin`
  expect(await blobId(bytes('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  expect(await blobId(withoutCr(bytes('hello\r\n')))).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  const binary = new Uint8Array([0, 13, 10])
  expect(withoutCr(binary)).toEqual(binary)
})

test('semver takes x.y.z from version lines and tags', () => {
  expect(semver('rtk 0.43.0')).toBe('0.43.0')
  expect(semver('v1.2.1')).toBe('1.2.1')
  expect(semver('dev-1.2.2-rc.670')).toBe('1.2.2')
  expect(semver('no version')).toBe(undefined)
})
