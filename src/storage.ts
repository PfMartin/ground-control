import type { Backend, Message, StoredData } from './types'

export const STORAGE_KEY = 'ground-control:v2'
export const LEGACY_STORAGE_KEY = 'ground-control:v1'
export const DEFAULT_MAX_BYTES = 131072
export const STORAGE_WARNING = 'Browser storage is unavailable or invalid. Changes may not survive a reload.'

export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, '0')).join('')
  }
  throw new Error('Secure random IDs are not available in this browser.')
}

export function normalizeUrl(input: string): string {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('Enter a valid HTTP(S) server URL.') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL must begin with http:// or https://.')
  if (url.username || url.password || url.href.includes('#') || url.href.includes('?')) throw new Error('URLs cannot contain credentials, a query, or a fragment.')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

export function validMaxBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Message limit must be a positive whole number of bytes.')
  return value
}

export function isInsecureRemote(input: string): boolean {
  const url = new URL(input)
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  return url.protocol === 'http:' && !loopback
}

function initialData(): StoredData {
  const backend = { id: newId(), name: 'Local example', url: 'http://127.0.0.1:8787/', maxMessageBytes: DEFAULT_MAX_BYTES, needsReview: false }
  return { version: 2, backends: [backend], selectedBackendId: backend.id, conversations: {}, activeRuns: {} }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function parseData(value: unknown, legacy: boolean): StoredData {
  if (!isRecord(value) || value.version !== (legacy ? 1 : 2) || !Array.isArray(value.backends) || !isRecord(value.conversations)) throw new Error('Invalid storage')
  const ids = new Set<string>()
  const backends: Backend[] = value.backends.map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || typeof item.url !== 'string') throw new Error('Invalid backend')
    ids.add(item.id)
    if (legacy) {
      const old = new URL(item.url)
      if ((old.protocol !== 'ws:' && old.protocol !== 'wss:') || old.username || old.password) throw new Error('Invalid legacy endpoint')
      const review = old.pathname !== '/' || old.href.includes('?') || old.href.includes('#')
      old.protocol = old.protocol === 'wss:' ? 'https:' : 'http:'
      old.search = ''; old.hash = ''
      return { id: item.id, name: item.name, url: normalizeUrl(old.toString()), maxMessageBytes: DEFAULT_MAX_BYTES, needsReview: review }
    }
    if (typeof item.maxMessageBytes !== 'number' || typeof item.needsReview !== 'boolean') throw new Error('Invalid backend settings')
    return { id: item.id, name: item.name, url: normalizeUrl(item.url), maxMessageBytes: validMaxBytes(item.maxMessageBytes), needsReview: item.needsReview }
  })
  if (value.selectedBackendId !== null && (typeof value.selectedBackendId !== 'string' || !ids.has(value.selectedBackendId))) throw new Error('Invalid selection')
  const conversations: Record<string, Message[]> = Object.create(null)
  for (const [id, messages] of Object.entries(value.conversations)) {
    if (!ids.has(id) || !Array.isArray(messages)) throw new Error('Invalid conversation')
    conversations[id] = messages.map((message: unknown) => {
      if (!isRecord(message) || typeof message.id !== 'string' || !message.id || (message.role !== 'user' && message.role !== 'assistant' && (legacy || (message.role !== 'backend' && message.role !== 'system'))) || typeof message.content !== 'string' || !['pending', 'complete', 'interrupted', 'failed', 'unknown', 'cancelled'].includes(String(message.status))) throw new Error('Invalid message')
      if (!legacy && (typeof message.sessionId !== 'string' || !message.sessionId)) throw new Error('Invalid session')
      const status = message.status === 'pending' ? (message.role === 'user' ? 'unknown' : 'interrupted') : message.status as Message['status']
      const result: Message = { id: message.id, sessionId: legacy ? `legacy-${id}` : message.sessionId as string, role: message.role as Message['role'], content: message.content, status }
      if (!legacy && typeof message.error === 'string') result.error = message.error
      return result
    })
  }
  // A tab can disappear without a close handler. Recover previously active runs as historical interruptions.
  if (!legacy && value.activeRuns !== undefined) {
    if (!isRecord(value.activeRuns)) throw new Error('Invalid run state')
    for (const [id, sessionId] of Object.entries(value.activeRuns)) {
      if (!ids.has(id) || typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid run state')
      const messages = conversations[id] ?? []
      messages.push({ id: newId(), sessionId, role: 'system', content: 'Agent activity ended before settlement; side effects may have occurred.', status: 'interrupted' })
      conversations[id] = messages
    }
  }
  return { version: 2, backends, selectedBackendId: value.selectedBackendId as string | null, conversations, activeRuns: {} }
}

export function loadData(storage: Storage | null): { data: StoredData; warning: string | null; migrated: boolean; canWrite: boolean } {
  try {
    if (!storage) throw new Error('Storage unavailable')
    const raw = storage.getItem(STORAGE_KEY)
    if (raw !== null) return { data: parseData(JSON.parse(raw), false), warning: null, migrated: false, canWrite: true }
    const old = storage.getItem(LEGACY_STORAGE_KEY)
    if (old !== null) {
      const data = parseData(JSON.parse(old), true)
      return { data, warning: data.backends.some((item) => item.needsReview) ? 'Some migrated endpoints need review before connecting; legacy query strings were removed.' : null, migrated: true, canWrite: true }
    }
    return { data: initialData(), warning: null, migrated: false, canWrite: true }
  } catch {
    // Do not overwrite data we could not parse.
    return { data: initialData(), warning: STORAGE_WARNING, migrated: false, canWrite: false }
  }
}
export function browserStorage(): Storage | null { try { return window.localStorage } catch { return null } }
