import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createEncryption } from './encryption.mjs'

const exec = promisify(execFile)
export const root = fileURLToPath(new URL('.', import.meta.url))
export const runtime = join(root, '.runtime')
const service = 'ai.dify.local-chatgpt-bridge'
const account = 'local-credential-encryption'

async function keychainKey(create = false) {
  if (process.platform !== 'darwin') throw new Error('This local runtime requires macOS Keychain.')
  try {
    const { stdout } = await exec('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'])
    const key = Buffer.from(stdout.trim(), 'base64')
    if (key.length !== 32) throw new Error('Invalid key length')
    return key
  } catch (error) {
    if (create && error.code === 44) {
      const key = randomBytes(32)
      try { await exec('/usr/bin/security', ['add-generic-password', '-s', service, '-a', account, '-w', key.toString('base64')]) }
      catch { throw new Error('Could not create the bridge key in macOS Keychain. Unlock Keychain and retry setup.') }
      return key
    }
    throw new Error('The bridge encryption key is unavailable. Unlock macOS Keychain, or run setup for a new installation.')
  }
}

export async function setupRuntime() {
  await mkdir(runtime, { recursive: true, mode: 0o700 })
  await chmod(runtime, 0o700)
  await keychainKey(true)
  const keyFile = join(runtime, 'api-key')
  try { await writeFile(keyFile, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  await chmod(keyFile, 0o600)
}

export async function bridgeKey() {
  try { return (await readFile(join(runtime, 'api-key'), 'utf8')).trim() }
  catch { throw new Error('Run setup before starting the bridge.') }
}

export async function createClient() {
  const key = await keychainKey()
  let sdk
  try { sdk = await import(new URL('./.runtime/sdk/packages/local/dist/index.js', import.meta.url)) }
  catch { throw new Error('The official SDK is not built. Run python3 docker/chatgpt-bridge/setup.py.') }
  return sdk.createChatGPT({ appName: 'Dify Local Bridge', appId: 'dify-local-chatgpt-bridge',
    redirectPort: 0, sendHostId: true, storageDir: join(runtime, 'state'),
    credentialEncryption: createEncryption(key),
    // Never print authorization URLs: returning-account URLs can contain an ID-token hint.
    openBrowser: async url => { await exec('/usr/bin/open', [url]) },
  })
}
