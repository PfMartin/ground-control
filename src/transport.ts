import { parseServerFrame, serializeClientFrame, type ClientFrame, type Frame } from './protocol'

export interface TransportHandlers {
  onOpen: () => void
  onClose: (code: number) => void
  onError: () => void
  onProtocolError: (message: string) => void
  onFrame: (frame: Frame) => void
}
export interface AgentTransport {
  send(frame: ClientFrame): void
  close(): void
}
export type TransportFactory = (baseUrl: string, token: string, maxBytes: number, handlers: TransportHandlers, signal: AbortSignal) => Promise<AgentTransport>

/** Browser ticket exchange and pi-rpc-v1 WebSocket framing. */
export const openPiTransport: TransportFactory = async (baseUrl, token, maxBytes, handlers, signal) => {
  let response: Response
  try {
    response = await fetch(new URL('auth/ws-ticket', baseUrl), {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit', redirect: 'error', signal,
    })
  } catch {
    if (signal.aborted) throw new DOMException('Connection cancelled', 'AbortError')
    throw new Error('Ticket request failed. Check the server URL, TLS, CORS, and allowed origin.')
  }
  if (!response.ok) throw new Error(`Ticket request failed (HTTP ${response.status}). Check authentication and server configuration.`)
  let body: unknown
  try { body = await response.json() } catch { throw new Error('Invalid ticket response.') }
  if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).ticket !== 'string' || !(body as Record<string, unknown>).ticket || typeof (body as Record<string, unknown>).expiresIn !== 'number' || ((body as Record<string, unknown>).expiresIn as number) <= 0) throw new Error('Invalid ticket response.')
  if (signal.aborted) throw new DOMException('Connection cancelled', 'AbortError')
  const wsUrl = new URL(baseUrl)
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  wsUrl.searchParams.set('ticket', (body as { ticket: string }).ticket)
  let socket: WebSocket
  try { socket = new WebSocket(wsUrl, 'pi-rpc-v1') } catch { throw new Error('Could not open the WebSocket. Check the URL and browser security restrictions.') }
  socket.onopen = () => handlers.onOpen()
  socket.onerror = () => handlers.onError()
  socket.onclose = (event) => handlers.onClose(event.code)
  socket.onmessage = (event) => {
    let frame: Frame
    try { frame = parseServerFrame(event.data) } catch (error) {
      handlers.onProtocolError(error instanceof Error ? error.message : 'Invalid frame.')
      return
    }
    handlers.onFrame(frame)
  }
  const closeOnAbort = () => { try { socket.close(1000, 'Client disconnect') } catch { /* Already closing. */ } }
  signal.addEventListener('abort', closeOnAbort, { once: true })
  if (signal.aborted) closeOnAbort()
  return {
    send: (frame) => {
      const serialized = serializeClientFrame(frame, maxBytes)
      if (socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open.')
      socket.send(serialized)
    },
    close: () => { signal.removeEventListener('abort', closeOnAbort); closeOnAbort() },
  }
}
