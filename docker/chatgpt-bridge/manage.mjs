import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { open, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, bridgeKey, setupRuntime, runtime } from './runtime.mjs'
import { createBridge } from './server.mjs'

const entry = fileURLToPath(import.meta.url)
const port = Number(process.env.DIFY_CHATGPT_BRIDGE_PORT ?? 8099)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a port between 1024 and 65535.')
const exec = promisify(execFile)
const command = process.argv[2] ?? 'status'

async function ownProcess() {
  try {
    const pid = Number((await readFile(join(runtime, 'bridge.pid'), 'utf8')).trim())
    if (!Number.isSafeInteger(pid) || pid < 2) return undefined
    const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'command='])
    return stdout.includes(`${entry} serve`) ? pid : undefined
  } catch { return undefined }
}

async function main() {
  if (command === 'setup') { await setupRuntime(); console.log('Local key ready; encryption key is in macOS Keychain.'); return }
  if (command === 'serve') {
    const server = createBridge({ client: await createClient(), apiKey: await bridgeKey() })
    server.on('error', error => { console.error(`Bridge could not listen (${error.code ?? 'listen_error'}).`); process.exitCode = 1 })
    server.listen(port, '127.0.0.1', () => console.log(`Dify local ChatGPT bridge listening on port ${port}.`))
    const stop = () => { server.close(); server.closeAllConnections() }
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
    return
  }
  if (command === 'start') {
    if (await ownProcess()) { console.log('Bridge is already running.'); return }
    await bridgeKey()
    const log = await open(join(runtime, 'bridge.log'), 'a', 0o600)
    const child = spawn(process.execPath, [entry, 'serve'], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env })
    child.unref()
    await writeFile(join(runtime, 'bridge.pid'), String(child.pid), { mode: 0o600 })
    await log.close()
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 200))
      if (!(await ownProcess())) break
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })
        if (response.ok) { console.log(`Bridge running. Dify base URL: http://host.docker.internal:${port}/v1`); return }
      } catch { /* Wait for the SDK and Keychain to initialize. */ }
    }
    throw new Error('Bridge did not become ready. Check .runtime/bridge.log and macOS Keychain access.')
  }
  if (command === 'stop') {
    const pid = await ownProcess()
    if (pid) process.kill(pid, 'SIGTERM')
    await unlink(join(runtime, 'bridge.pid')).catch(() => {})
    console.log(pid ? 'Bridge stopped.' : 'Bridge is not running.')
    return
  }
  if (command === 'config') {
    // Explicit local configuration command; never prints OAuth credentials.
    const models = await (await createClient()).listModels()
    const model = process.argv[3] ?? models[0]?.slug
    if (!models.some(m => m.slug === model)) throw new Error('Choose an available model from the models command.')
    console.log(JSON.stringify({ provider: 'langgenius/openai/openai', model, credentials: {
      openai_api_key: await bridgeKey(), openai_api_base: `http://host.docker.internal:${port}/v1`,
      validate_model: model, api_protocol: 'chat', enable_request_metadata: 'disabled',
    } }, null, 2))
    return
  }
  const client = await createClient()
  if (command === 'login') {
    console.log('Opening the official ChatGPT sign-in page. Approve ChatGPT plan usage in your browser.')
    const abort = new AbortController()
    process.once('SIGINT', () => { abort.abort(); client.cancelSignIn() })
    await client.signIn({ signal: abort.signal, ...(process.argv.includes('--new-account') ? { newProfile: true } : {}), ...(process.argv.includes('--enable-plan') ? { reconsent: true } : {}) })
    console.log(JSON.stringify(await client.getSession(), null, 2))
    return
  }
  if (command === 'status') { console.log(JSON.stringify({ running: Boolean(await ownProcess()), session: await client.getSession() }, null, 2)); return }
  if (command === 'models') { console.log(JSON.stringify(await client.listModels(), null, 2)); return }
  if (command === 'disconnect') { await client.disconnect(); console.log('Disconnected; registration retained for future sign-in.'); return }
  if (command === 'verify') {
    const models = await client.listModels()
    if (!models.length) throw new Error('No models are available for this account.')
    const model = process.argv[3] ?? models[0].slug
    if (!models.some(m => m.slug === model)) throw new Error('Choose a model from the models command.')
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${await bridgeKey()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: Connection works.' }], temperature: 0.2, max_tokens: 20 }),
      signal: AbortSignal.timeout(240_000) })
    const result = await response.json()
    if (!response.ok || !result.choices?.[0]?.message?.content) throw new Error(`Verification failed (${result.error?.code ?? response.status}).`)
    console.log(`Verified model: ${model}\n${result.choices[0].message.content}`)
    return
  }
  throw new Error('Commands: setup, start, stop, status, login [--new-account] [--enable-plan], models, verify [model], disconnect, config.')
}

main().catch(error => {
  // SDK error messages and child-process errors may contain sensitive URLs or submitted text.
  const safeCode = typeof error?.code === 'string' && /^[a-z_]{1,100}$/.test(error.code) ? error.code : undefined
  if (safeCode) console.error(`ChatGPT connection error: ${safeCode}. Check status; retry login if required.`)
  else if (error?.name === 'ChatGPTError') console.error('ChatGPT connection failed. Check status and try login again.')
  else console.error(error instanceof Error && !('cmd' in error) ? error.message : 'Local runtime command failed.')
  process.exitCode = 1
})
