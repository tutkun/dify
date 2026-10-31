import { createServer } from 'node:http'
import { timingSafeEqual, randomUUID } from 'node:crypto'
import { RequestError, normalizeRequest, completedResponse, publicError } from './adapter.mjs'

const LIMIT = 1024 * 1024
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}
async function readBody(req) {
  if (Number(req.headers['content-length']) > LIMIT) throw new RequestError('Request exceeds 1 MiB.', 413, 'request_too_large')
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > LIMIT) throw new RequestError('Request exceeds 1 MiB.', 413, 'request_too_large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new RequestError('Request body must be valid JSON.') }
}

export function createBridge({ client, apiKey }) {
  if (typeof apiKey !== 'string' || apiKey.length < 16) throw new Error('A local bridge key of at least 16 characters is required.')
  const expected = Buffer.from(`Bearer ${apiKey}`)
  let active = 0
  const server = createServer(async (req, res) => {
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })
    const deadline = setTimeout(() => controller.abort(), 240_000)
    let counted = false
    let route
    let sequence = 0
    let responseId
    let created
    let model
    const emit = (event, data) => {
      if (res.destroyed) throw new RequestError('Client disconnected.', 499, 'cancelled')
      if (res.writableLength > LIMIT) { controller.abort(); throw new RequestError('Client is too slow.', 502, 'slow_client') }
      res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
    }
    const chatChunk = (delta, finish = null) => ({ id: responseId, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finish }] })
    const responseEvent = (type, data = {}) => emit(type, { type, sequence_number: sequence++, ...data })
    let started = false
    const startStream = () => {
      if (started) return
      started = true
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' })
      if (route === 'chat') emit(null, chatChunk({ role: 'assistant', content: '' }))
      else {
        responseEvent('response.created', { response: { id: responseId, object: 'response', model, created_at: created, status: 'in_progress', output: [] } })
        responseEvent('response.output_item.added', { output_index: 0, item: { id: `msg_${responseId}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
        responseEvent('response.content_part.added', { item_id: `msg_${responseId}`, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      }
    }
    try {
      const path = req.url?.split('?')[0]
      if (path === '/healthz' && req.method === 'GET') { json(res, 200, { status: 'ok' }); return }
      const received = Buffer.from(req.headers.authorization ?? '')
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new RequestError('Invalid local bridge key.', 401, 'invalid_api_key')
      // This API is for Dify, not arbitrary browser pages. No cross-origin API access.
      if (req.headers.origin) throw new RequestError('Browser API requests are not supported.', 403, 'origin_not_allowed')
      if (active >= 8) throw new RequestError('Bridge is busy. Retry later.', 429, 'bridge_busy')
      active++; counted = true
      if (path === '/v1/models' && req.method === 'GET') {
        const models = await client.listModels({ signal: controller.signal })
        json(res, 200, { object: 'list', data: models.map(m => ({ id: m.slug, object: 'model', created: 0, owned_by: 'chatgpt' })) })
        return
      }
      route = path === '/v1/chat/completions' ? 'chat' : path === '/v1/responses' ? 'responses' : undefined
      if (!route || req.method !== 'POST') throw new RequestError('Supported routes: GET /v1/models, POST /v1/chat/completions and POST /v1/responses. Text generation only.', 400, 'unsupported_endpoint')
      const body = await readBody(req)
      const options = normalizeRequest(body, route)
      const models = await client.listModels({ signal: controller.signal })
      if (!models.some(m => m.slug === options.model)) throw new RequestError('This model is not available to the connected ChatGPT account. Choose a model from /v1/models.', 404, 'model_not_found')
      model = options.model
      created = Math.floor(Date.now() / 1000)
      responseId = `${route === 'chat' ? 'chatcmpl' : 'resp'}_${randomUUID().replaceAll('-', '')}`
      const result = await client.streamResponse({ ...options, signal: controller.signal,
        onDelta: delta => {
          if (!body.stream) return
          startStream()
          if (route === 'chat') emit(null, chatChunk({ content: delta }))
          else responseEvent('response.output_text.delta', { item_id: `msg_${responseId}`, output_index: 0, content_index: 0, delta, logprobs: [] })
        } })
      controller.signal.throwIfAborted()
      if (typeof result?.text !== 'string') throw new RequestError('Invalid completed response.', 502, 'invalid_stream')
      const completed = completedResponse(responseId, model, result.text, created)
      if (!body.stream) {
        json(res, 200, route === 'chat' ? { id: responseId, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }] } : completed)
      } else {
        startStream()
        if (route === 'chat') { emit(null, chatChunk({}, 'stop')); res.end('data: [DONE]\n\n') }
        else {
          responseEvent('response.output_text.done', { item_id: `msg_${responseId}`, output_index: 0, content_index: 0, text: result.text, logprobs: [] })
          responseEvent('response.content_part.done', { item_id: `msg_${responseId}`, output_index: 0, content_index: 0, part: completed.output[0].content[0] })
          responseEvent('response.output_item.done', { output_index: 0, item: completed.output[0] })
          responseEvent('response.completed', { response: completed })
          res.end()
        }
      }
    } catch (error) {
      if (res.destroyed || res.writableEnded) return
      const safe = publicError(controller.signal.aborted ? { code: 'request_cancelled', status: 504 } : error)
      if (!res.headersSent) json(res, safe.status, { error: safe.error })
      else {
        // A full socket buffer cannot carry another error event. Never let error
        // serialization escape the async request listener and terminate Node.
        if (res.writableLength > LIMIT) { res.destroy(); return }
        try {
          if (route === 'responses') responseEvent('response.failed', { response: { id: responseId, object: 'response', model, status: 'failed', error: safe.error } })
          else emit(null, { error: safe.error })
          res.end()
        } catch { res.destroy() }
      }
    } finally {
      clearTimeout(deadline)
      if (counted) active--
    }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 15_000
  server.keepAliveTimeout = 5000
  return server
}
