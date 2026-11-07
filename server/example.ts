import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'

export const DEMO_TOKEN = 'local-example-token'
export const DEMO_ORIGIN = 'http://127.0.0.1:5173'
export interface ExampleServer { server: Server; close: () => Promise<void> }

/** A loopback-only protocol demonstration, not an AI backend or production service. */
export function createExampleServer(port = 8787, origin = DEMO_ORIGIN, token = DEMO_TOKEN): ExampleServer {
  const tickets = new Map<string, { origin: string; expires: number }>()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 131072, handleProtocols: (protocols) => protocols.has('pi-rpc-v1') ? 'pi-rpc-v1' : false })
  const server = createServer((request, response) => {
    if (new URL(request.url ?? '/', 'http://example.invalid').pathname !== '/auth/ws-ticket') { response.writeHead(404).end(); return }
    if (request.headers.origin !== origin) { response.writeHead(403).end(); return }
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
    if (request.method === 'OPTIONS') { response.writeHead(204, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization' }).end(); return }
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    if ((request.headers['content-length'] && request.headers['content-length'] !== '0') || request.headers['transfer-encoding']) { response.writeHead(400).end(); request.resume(); return }
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return }
    for (const [id, ticket] of tickets) if (ticket.expires <= Date.now()) tickets.delete(id)
    if (tickets.size >= 1000) { response.writeHead(503).end(); return }
    const ticket = randomUUID(); tickets.set(ticket, { origin, expires: Date.now() + 30_000 })
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ticket, expiresIn: 30 }))
  })
  server.on('upgrade', (request, socket, head) => {
    const reject = (status: number) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    const url = new URL(request.url ?? '/', 'http://example.invalid')
    const values = url.searchParams.getAll('ticket')
    if (url.pathname !== '/' || values.length !== 1 || request.headers.authorization) { reject(400); return }
    const offered = (request.headers['sec-websocket-protocol'] ?? '').split(',').map((item) => item.trim())
    if (!offered.includes('pi-rpc-v1')) { reject(426); return }
    const ticket = tickets.get(values[0]); tickets.delete(values[0])
    if (!ticket || ticket.expires <= Date.now() || request.headers.origin !== ticket.origin || request.headers.origin !== origin) { reject(401); return }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request))
  })
  wss.on('connection', (socket) => {
    type Active = { id: string; text: string; position: number; timer?: ReturnType<typeof setTimeout>; dialogId?: string; started: boolean }
    let active: Active | null = null
    const send = (frame: object) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)) }
    const finish = (run: Active, aborted: boolean) => {
      if (active !== run) return
      if (run.timer) clearTimeout(run.timer)
      if (run.started) send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: run.text.slice(0, run.position) }], stopReason: aborted ? 'aborted' : 'stop' } })
      send({ type: 'agent_end', willRetry: false }); send({ type: 'agent_settled', aborted }); active = null
    }
    const startResponse = (run: Active, text: string) => {
      if (active !== run) return
      run.text = text; run.started = true
      send({ type: 'message_start', message: { role: 'assistant', content: [] } })
      const chunk = () => {
        if (active !== run || socket.readyState !== WebSocket.OPEN) return
        if (run.position >= run.text.length) {
          send({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: run.text } })
          finish(run, false); return
        }
        const delta = run.text.slice(run.position, run.position + 12); run.position += delta.length
        send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } })
        run.timer = setTimeout(chunk, 30)
      }
      chunk()
    }
    socket.on('error', () => {})
    socket.on('close', () => { if (active?.timer) clearTimeout(active.timer); active = null })
    socket.on('message', (raw, binary) => {
      if (binary) { socket.close(1003, 'Text frames only'); return }
      let value: unknown
      try { value = JSON.parse(raw.toString()) } catch { send({ type: 'server_error', code: 'INVALID_COMMAND' }); return }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { send({ type: 'server_error', code: 'INVALID_COMMAND' }); return }
      const command = value as Record<string, unknown>
      if (typeof command.id !== 'string' || !command.id || command.id.length > 128) { send({ type: 'server_error', code: 'INVALID_COMMAND' }); return }
      const id = command.id
      const keys = Object.keys(command)
      if (command.type === 'extension_ui_response') {
        const valid = keys.length === 3 && active?.dialogId === id && (typeof command.confirmed === 'boolean' || command.cancelled === true)
        if (!valid || !active) { send({ type: 'server_error', code: 'INVALID_COMMAND' }); return }
        const run = active; run.dialogId = undefined
        startResponse(run, `**Dialog result:** ${command.cancelled === true ? 'cancelled' : command.confirmed ? 'confirmed' : 'declined'}\n\n_This is a local demo, not an AI response._`); return
      }
      if (command.type === 'prompt' && keys.length === 3 && typeof command.message === 'string' && command.message.length > 0 && command.message.length <= 131072) {
        if (active) { send({ type: 'response', command: 'prompt', id, success: false, error: 'Agent is busy.' }); return }
        const input = command.message
        const run: Active = { id, text: '', position: 0, started: false }; active = run
        send({ type: 'response', command: 'prompt', id, success: true, data: { disposition: 'started' } })
        send({ type: 'agent_start' }); send({ type: 'message_start', message: { role: 'user', content: input } }); send({ type: 'message_end', message: { role: 'user', content: input } })
        if (input === '/demo-dialog') {
          run.dialogId = randomUUID()
          send({ type: 'extension_ui_request', id: run.dialogId, method: 'confirm', title: 'Example extension dialog', message: 'Would you like to confirm this demonstration?' })
        } else startResponse(run, `**Example response**\n\nYou said:\n\n${input}\n\n_This is a local demo, not an AI response._`)
        return
      }
      if (command.type === 'abort' && keys.length === 2) { if (active) finish(active, true); send({ type: 'response', command: 'abort', id, success: true }); return }
      if (command.type === 'new_session' && keys.length === 2) {
        if (active) send({ type: 'response', command: 'new_session', id, success: false, error: 'Agent is busy.' })
        else send({ type: 'response', command: 'new_session', id, success: true, data: { cancelled: false } })
        return
      }
      send({ type: 'server_error', code: 'INVALID_COMMAND' })
    })
    send({ type: 'server_ready', protocolVersion: 1, connectionId: randomUUID() })
  })
  server.listen(port, '127.0.0.1')
  return { server, close: async () => {
    for (const client of wss.clients) client.terminate()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  } }
}
