import { vi } from 'vitest'
import type { ClientFrame } from './protocol'
import type { TransportFactory, TransportHandlers } from './transport'

export function fakeTransports() {
  const connections: { url: string; token: string; maxBytes: number; handlers: TransportHandlers; close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn<(frame: ClientFrame) => void>>; signal: AbortSignal }[] = []
  const factory: TransportFactory = async (url, token, maxBytes, handlers, signal) => {
    const connection = { url, token, maxBytes, handlers, signal, close: vi.fn(), send: vi.fn<(frame: ClientFrame) => void>() }
    connections.push(connection)
    return connection
  }
  return { factory, connections }
}

export const readyFrame = { type: 'server_ready', protocolVersion: 1, connectionId: 'connection' } as const
