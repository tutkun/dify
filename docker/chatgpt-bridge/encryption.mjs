import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// The caller obtains this key from macOS Keychain. It is never written beside the ciphertext.
export function createEncryption(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Keychain returned an invalid encryption key.')
  const aad = Buffer.from('dify-local-chatgpt-keychain-v1')
  return {
    id: 'dify-local-chatgpt-keychain-v1',
    isAvailable: () => true,
    encrypt(plaintext) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(aad)
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decrypt(ciphertext) {
      const bytes = Buffer.from(ciphertext)
      if (bytes.length < 28) throw new Error('Invalid encrypted credentials.')
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAAD(aad)
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
}
