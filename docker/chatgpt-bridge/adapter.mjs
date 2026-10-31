export class RequestError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message)
    this.status = status
    this.code = code
  }
}

function textContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content) && content.every(part => part && ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string')) {
    return content.map(part => part.text).join('')
  }
  throw new RequestError('This bridge accepts text content only; media requires another provider.')
}

function nonemptyArray(value) {
  if (value === undefined || value === null) return false
  if (!Array.isArray(value)) throw new RequestError('Tools, functions, tool calls and modalities must be arrays.')
  return value.length > 0
}

// Build an allowlisted SDK request. Unsupported generation settings never reach OpenAI.
export function normalizeRequest(body, route) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Send a JSON object.')
  if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 200) throw new RequestError('Provide a model from /v1/models.')
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new RequestError('stream must be a boolean.')
  if (nonemptyArray(body.tools) || nonemptyArray(body.functions) ||
      (body.tool_choice !== undefined && body.tool_choice !== 'none') || body.function_call ||
      body.response_format && body.response_format.type !== 'text' || body.text?.format && body.text.format.type !== 'text' ||
      body.n !== undefined && body.n !== 1 || body.audio || nonemptyArray(body.modalities) && body.modalities.some(x => x !== 'text') ||
      body.stop && (!Array.isArray(body.stop) || body.stop.length) || body.previous_response_id || body.conversation || body.background === true) {
    throw new RequestError('Tools, structured output, media, stop sequences, background jobs and server-side conversation state are not supported. Use text messages and full history.')
  }
  if (body.instructions !== undefined && typeof body.instructions !== 'string') throw new RequestError('instructions must be text.')
  let messages = route === 'chat' ? body.messages : body.input
  if (route === 'responses' && typeof messages === 'string') messages = [{ role: 'user', content: messages }]
  if (!Array.isArray(messages) || !messages.length || messages.length > 1000) throw new RequestError('Provide 1–1000 text messages.')
  const input = messages.map(message => {
    if (!message || !['system', 'developer', 'user', 'assistant'].includes(message.role) ||
        message.type !== undefined && message.type !== 'message' || nonemptyArray(message.tool_calls) || message.function_call) {
      throw new RequestError('Only text user, assistant, system and developer messages are supported.')
    }
    return { role: message.role === 'system' ? 'developer' : message.role, content: textContent(message.content) }
  })
  return { model: body.model, input, ...(body.instructions === undefined ? {} : { instructions: body.instructions }) }
}

export function completedResponse(id, model, text, created) {
  return { id, object: 'response', created_at: created, status: 'completed', model,
    output: [{ id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }] }], error: null, incomplete_details: null }
}

export function publicError(error) {
  if (error instanceof RequestError) return { status: error.status, error: { message: error.message, type: 'invalid_request_error', code: error.code } }
  const code = typeof error?.code === 'string' && /^[a-z_]{1,100}$/.test(error.code) ? error.code : 'bridge_error'
  const reauth = ['sign_in_required', 'invalid_grant', 'invalid_refresh_token', 'refresh_token_expired', 'refresh_token_reused', 'token_expired', 'invalid_token']
  let status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502
  if (reauth.includes(code)) status = 401
  if (code === 'sharing_not_enabled') status = 403
  if (code.includes('limit_exceeded')) status = 429
  const message = status === 401 ? 'Run the bridge login command to connect or renew your ChatGPT account.'
    : status === 403 ? 'Enable ChatGPT plan usage for this connection; check account eligibility and permissions.'
      : status === 429 ? 'ChatGPT usage limit reached. Check https://chatgpt.com/settings/usage.'
        : 'ChatGPT could not complete this request. Check bridge status or reconnect your account.'
  return { status, error: { message, type: 'api_error', code } }
}
