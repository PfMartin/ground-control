import { afterEach, describe, expect, it, vi } from 'vitest'
import { openPiTransport, type TransportHandlers } from './transport'

class MockSocket {
  static current: MockSocket
  static OPEN = 1
  readyState = 1
  onopen: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor(public url: URL, public protocol: string) { MockSocket.current = this }
}
function handlers(): TransportHandlers { return { onOpen: vi.fn(), onClose: vi.fn(), onError: vi.fn(), onFrame: vi.fn(), onProtocolError: vi.fn() } }
afterEach(() => vi.unstubAllGlobals())

describe('browser Pi transport', () => {
  it('uses an empty authenticated ticket POST and a single-use ticket with subprotocol', async () => {
    vi.stubGlobal('WebSocket', MockSocket)
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ticket: 'ticket/+?', expiresIn: 30 }) })
    vi.stubGlobal('fetch', fetch)
    const events = handlers(); const abort = new AbortController()
    const adapter = await openPiTransport('https://example.test/proxy/', 'private-token', 1024, events, abort.signal)
    const [url, options] = fetch.mock.calls[0]
    expect(url.toString()).toBe('https://example.test/proxy/auth/ws-ticket')
    expect(options).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer private-token' }, credentials: 'omit', cache: 'no-store', redirect: 'error' })
    expect(options).not.toHaveProperty('body')
    const socket = MockSocket.current
    expect(socket.url.origin + socket.url.pathname).toBe('wss://example.test/proxy/')
    expect(socket.url.searchParams.get('ticket')).toBe('ticket/+?')
    expect(socket.protocol).toBe('pi-rpc-v1')
    expect(socket.url.toString()).not.toContain('private-token')
    socket.onopen?.(); expect(events.onOpen).toHaveBeenCalledOnce()
    adapter.send({ type: 'prompt', id: 'a', message: 'hi' })
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: 'prompt', id: 'a', message: 'hi' })
    socket.onmessage?.({ data: '{"type":"server_ready","protocolVersion":1}' })
    expect(events.onFrame).toHaveBeenCalledOnce()
    socket.onmessage?.({ data: '{bad' }); expect(events.onProtocolError).toHaveBeenCalledOnce()
    socket.onclose?.({ code: 1001 }); expect(events.onClose).toHaveBeenCalledWith(1001)
    adapter.close(); expect(socket.close).toHaveBeenCalledOnce()
  })
  it('does not open a socket on bad auth, malformed ticket, or cancelled exchange', async () => {
    vi.stubGlobal('WebSocket', MockSocket)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))
    await expect(openPiTransport('http://127.0.0.1/', 'secret', 100, handlers(), new AbortController().signal)).rejects.toThrow('HTTP 401')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ticket: 4 }) }))
    await expect(openPiTransport('http://127.0.0.1/', 'secret', 100, handlers(), new AbortController().signal)).rejects.toThrow('Invalid ticket')
    const abort = new AbortController(); abort.abort()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('cancelled')))
    await expect(openPiTransport('http://127.0.0.1/', 'secret', 100, handlers(), abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
