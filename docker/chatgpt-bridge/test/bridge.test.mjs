import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { createBridge } from '../server.mjs'
import { normalizeRequest } from '../adapter.mjs'

const key = 'test-local-bridge-key'
async function fixture(t, changes = {}) {
  const client = {
    async listModels() { return [{ slug: 'available-model', displayName: 'Available model' }] },
    async streamResponse({ onDelta }) { onDelta?.('Merhaba '); onDelta?.('dünya 🌍'); return { text: 'Merhaba dünya 🌍' } },
    ...changes,
  }
  const server = createBridge({ client, apiKey: key })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (path, body, auth = key) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { request, base }
}

test('normalizes history and omits unsupported generation parameters upstream', () => {
  const result = normalizeRequest({ model: 'available-model', messages: [
    { role: 'system', content: 'Türkçe yanıtla' },
    { role: 'user', content: [{ type: 'text', text: 'Merhaba' }] },
    { role: 'assistant', content: 'Selam' },
    { role: 'user', content: 'Nasılsın?' },
  ], temperature: 0.3, top_p: 0.9, max_tokens: 123, metadata: { any: 'value' } }, 'chat')
  assert.deepEqual(result, { model: 'available-model', input: [
    { role: 'developer', content: 'Türkçe yanıtla' }, { role: 'user', content: 'Merhaba' },
    { role: 'assistant', content: 'Selam' }, { role: 'user', content: 'Nasılsın?' },
  ] })
})

test('normalizes Responses instructions, string input and system messages', () => {
  assert.deepEqual(normalizeRequest({ model: 'available-model', instructions: 'Be brief', input: 'Hi', store: true }, 'responses'), {
    model: 'available-model', instructions: 'Be brief', input: [{ role: 'user', content: 'Hi' }],
  })
  assert.equal(normalizeRequest({ model: 'm', input: [{ type: 'message', role: 'system', content: 'guide' }] }, 'responses').input[0].role, 'developer')
})

test('rejects tools, structured output, media and malformed messages explicitly', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
  for (const extra of [{ tools: [{ type: 'function' }] }, { response_format: { type: 'json_object' } }, { n: 2 },
    { messages: [{ role: 'tool', content: 'result' }] }, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] },
    { messages: null }, { model: null }, { stream: 'yes' }, { modalities: 'text' }, { functions: {} },
    { messages: [{ role: 'assistant', content: 'hi', tool_calls: {} }] }, { messages: [{ role: 'user', content: 5 }] }]) {
    assert.throws(() => normalizeRequest({ ...base, ...extra }, 'chat'), error => error.status === 400)
  }
})

test('requires the local bridge key even for the model catalog', async t => {
  const { request } = await fixture(t)
  assert.equal((await request('/v1/models', undefined, 'wrong')).status, 401)
  const response = await request('/v1/models')
  assert.deepEqual((await response.json()).data.map(x => x.id), ['available-model'])
})

test('returns a completed Chat Completions response for nonstreaming callers', async t => {
  const { request } = await fixture(t)
  const response = await request('/v1/chat/completions', { model: 'available-model', messages: [{ role: 'user', content: 'Hi' }] })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.choices[0].message.content, 'Merhaba dünya 🌍')
  assert.equal(body.choices[0].finish_reason, 'stop')
  assert.equal(body.object, 'chat.completion')
  assert.equal(body.usage, undefined) // The SDK does not report usage; do not fabricate it.
})

test('streams Unicode Chat Completions deltas and terminates only on completion', async t => {
  const { request } = await fixture(t)
  const response = await request('/v1/chat/completions', { model: 'available-model', stream: true, messages: [{ role: 'user', content: 'Hi' }] })
  const events = (await response.text()).split('\n').filter(x => x.startsWith('data: ')).map(x => x.slice(6))
  assert.equal(events.at(-1), '[DONE]')
  const chunks = events.slice(0, -1).map(x => JSON.parse(x))
  assert.equal(chunks.map(x => x.choices[0].delta.content ?? '').join(''), 'Merhaba dünya 🌍')
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
})

test('supports Responses JSON and named SSE events', async t => {
  const { request } = await fixture(t)
  const json = await (await request('/v1/responses', { model: 'available-model', input: 'Hi' })).json()
  assert.equal(json.status, 'completed')
  assert.equal(json.output[0].content[0].text, 'Merhaba dünya 🌍')
  const response = await request('/v1/responses', { model: 'available-model', input: 'Hi', stream: true })
  const text = await response.text()
  assert.match(text, /event: response.output_text.delta/)
  assert.match(text, /event: response.completed/)
})

test('does not emit successful completion after an interrupted upstream response', async t => {
  const { request } = await fixture(t, { async streamResponse({ onDelta }) {
    onDelta('partial'); throw Object.assign(new Error('Do not expose submitted text or tokens'), { code: 'stream_interrupted' })
  } })
  const response = await request('/v1/chat/completions', { model: 'available-model', stream: true, messages: [{ role: 'user', content: 'Hi' }] })
  const text = await response.text()
  assert.match(text, /stream_interrupted/)
  assert.doesNotMatch(text, /\[DONE\]|"finish_reason":"stop"|Do not expose/)
})

test('returns sanitized JSON errors before streaming and for completed callers', async t => {
  const { request } = await fixture(t, { async streamResponse() { throw Object.assign(new Error('secret prompt'), { code: 'sign_in_required' }) } })
  const response = await request('/v1/chat/completions', { model: 'available-model', messages: [{ role: 'user', content: 'Hi' }] })
  assert.equal(response.status, 401)
  assert.doesNotMatch(await response.text(), /secret prompt/)
})

test('rejects unknown models, invalid JSON, oversized input and unsupported routes', async t => {
  const { request, base } = await fixture(t)
  assert.equal((await request('/v1/chat/completions', { model: 'made-up', messages: [{ role: 'user', content: 'Hi' }] })).status, 404)
  assert.equal((await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: '{' })).status, 400)
  assert.equal((await request('/v1/chat/completions', { model: 'available-model', messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024 + 1) }] })).status, 413)
  assert.equal((await request('/v1/embeddings', { input: 'hi' })).status, 400)
})

test('aborts upstream inference when the client disconnects', async t => {
  let observedAbort
  const aborted = new Promise(resolve => { observedAbort = resolve })
  const { base } = await fixture(t, { async streamResponse({ onDelta, signal }) {
    onDelta('started')
    await new Promise(resolve => signal.addEventListener('abort', () => { observedAbort(); resolve() }, { once: true }))
    signal.throwIfAborted()
  } })
  const controller = new AbortController()
  const response = await fetch(base + '/v1/chat/completions', { method: 'POST', signal: controller.signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'available-model', stream: true, messages: [{ role: 'user', content: 'Hi' }] }) })
  await response.body.getReader().read()
  controller.abort()
  await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream not cancelled')), 1500))])
})

test('a slow client cannot crash the bridge during error serialization', async t => {
  const { base } = await fixture(t, { async streamResponse({ onDelta }) {
    onDelta('x'.repeat(1024 * 1024 + 1))
    onDelta('next')
    return { text: 'unused' }
  } })
  let output = ''
  try {
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(1000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'available-model', stream: true, messages: [{ role: 'user', content: 'Hi' }] }) })
    output = await response.text()
  } catch { /* An overloaded client connection is deliberately closed. */ }
  assert.doesNotMatch(output, /\[DONE\]/)
  assert.equal((await fetch(base + '/healthz')).status, 200)
})
