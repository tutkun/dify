import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { createEncryption } from '../encryption.mjs'

test('encrypts credentials without plaintext and decrypts across provider restarts', async () => {
  const key = randomBytes(32)
  const first = createEncryption(key)
  const plaintext = JSON.stringify({ accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token' })
  const ciphertext = await first.encrypt(plaintext)
  assert.ok(!Buffer.from(ciphertext).includes(Buffer.from('synthetic-access-token')))
  assert.equal(await createEncryption(key).decrypt(ciphertext), plaintext)
  assert.notDeepEqual(await first.encrypt(plaintext), ciphertext)
})

test('rejects tampered, truncated and wrong-key encrypted credentials', async () => {
  const provider = createEncryption(randomBytes(32))
  const encrypted = Buffer.from(await provider.encrypt('synthetic-secret'))
  const tampered = Buffer.from(encrypted)
  tampered[tampered.length - 1] ^= 1
  for (const data of [tampered, encrypted.subarray(0, 5)]) {
    await assert.rejects(async () => provider.decrypt(data))
  }
  await assert.rejects(async () => createEncryption(randomBytes(32)).decrypt(encrypted))
  assert.throws(() => createEncryption(Buffer.alloc(4)))
})
