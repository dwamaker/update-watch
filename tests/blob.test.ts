import { expect, test } from 'claude-code/testing'

import { blobId, withoutCr } from '../hooks/register'

const bytes = (s: string) => new TextEncoder().encode(s)

test('blob ids match git hash-object, CRLF folded only in text', async () => {
  // `printf 'hello\n' | git hash-object --stdin`
  expect(await blobId(bytes('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  expect(await blobId(withoutCr(bytes('hello\r\n')))).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  const binary = new Uint8Array([0, 13, 10])
  expect(withoutCr(binary)).toEqual(binary)
})
