// @vitest-environment node
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import { createExampleServer, DEMO_ORIGIN, DEMO_TOKEN } from './example'

describe('example Pi WebSocket backend', () => {
  it('authenticates tickets, enforces origin and single use, and streams a dialog and response', async () => {
    const example = createExampleServer(0)
    await once(example.server, 'listening')
    const address = example.server.address()
    if (!address || typeof address === 'string') throw new Error('No TCP address')
    const base = `http://127.0.0.1:${address.port}`
    const headers = { Origin: DEMO_ORIGIN, Authorization: `Bearer ${DEMO_TOKEN}` }
    let socket: WebSocket | undefined
    try {
      expect((await fetch(`${base}/auth/ws-ticket`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer wrong' } })).status).toBe(401)
      expect((await fetch(`${base}/auth/ws-ticket`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' } })).status).toBe(403)
      const response = await fetch(`${base}/auth/ws-ticket`, { method: 'POST', headers })
      expect(response.headers.get('cache-control')).toBe('no-store')
      const { ticket } = await response.json() as { ticket: string }
      socket = new WebSocket(base.replace('http:', 'ws:') + `/?ticket=${ticket}`, 'pi-rpc-v1', { headers: { Origin: DEMO_ORIGIN } })
      const frames: Array<Record<string, unknown>> = []
      socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())))
      await once(socket, 'open')
      const wait = async (predicate: (item: Record<string, unknown>) => boolean) => {
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          const index = frames.findIndex(predicate)
          if (index >= 0) return frames.splice(index, 1)[0]
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('Timed out waiting for example frame')
      }
      expect((await wait((frame) => frame.type === 'server_ready')).protocolVersion).toBe(1)
      socket.send(JSON.stringify({ type: 'prompt', id: 'p', message: '**hello**' }))
      expect(await wait((frame) => frame.type === 'response' && frame.id === 'p')).toMatchObject({ success: true, data: { disposition: 'started' } })
      await wait((frame) => frame.type === 'agent_settled')
      const updates = frames.filter((frame) => frame.type === 'message_update').map((frame) => frame.assistantMessageEvent as Record<string, unknown>)
      expect(updates.filter((event) => event.type === 'text_delta').map((event) => event.delta).join('')).toContain('**hello**')
      socket.send(JSON.stringify({ type: 'prompt', id: 'dialog-prompt', message: '/demo-dialog' }))
      const dialog = await wait((frame) => frame.type === 'extension_ui_request')
      expect(dialog).toMatchObject({ method: 'confirm' })
      socket.send(JSON.stringify({ type: 'extension_ui_response', id: dialog.id, confirmed: false }))
      await wait((frame) => frame.type === 'agent_settled')
      socket.send(JSON.stringify({ type: 'new_session', id: 'reset' }))
      expect(await wait((frame) => frame.id === 'reset')).toMatchObject({ success: true, data: { cancelled: false } })
      const replay = new WebSocket(base.replace('http:', 'ws:') + `/?ticket=${ticket}`, 'pi-rpc-v1', { headers: { Origin: DEMO_ORIGIN } })
      replay.on('error', () => {})
      const status = await new Promise<number>((resolve) => replay.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode ?? 0) }))
      expect(status).toBe(401)
      replay.terminate()
    } finally { socket?.terminate(); await example.close() }
  })
})
