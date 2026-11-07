import { serializeClientFrame, type ClientFrame, type DialogReply, type Frame } from './protocol'
import { browserStorage, DEFAULT_MAX_BYTES, LEGACY_STORAGE_KEY, loadData, newId, normalizeUrl, isInsecureRemote, STORAGE_KEY, STORAGE_WARNING, validMaxBytes } from './storage'
import { openPiTransport, type AgentTransport, type TransportFactory } from './transport'
import type { Backend, ConnectionStatus, ExtensionDialog, Message, Snapshot, StoredData, ToolStatus } from './types'

const COMMAND_TIMEOUT = 30_000
type CommandType = 'prompt' | 'abort' | 'new_session'
interface Pending { type: CommandType; timer: ReturnType<typeof setTimeout>; timedOut: boolean; messageId?: string; oldMessageIds?: Set<string> }
interface Prompt { id: string; messageId: string; responseReceived: boolean; sawSettlement: boolean }
interface DialogEntry { dialog: ExtensionDialog; timer?: ReturnType<typeof setTimeout> }
interface Connection {
  backendId: string
  sessionId: string
  transport: AgentTransport | null
  abortController: AbortController
  ready: boolean
  running: boolean
  runLabel: string | null
  prompt: Prompt | null
  echo: { id: string; text: string; reconciled: boolean } | null
  pending: Map<string, Pending>
  dialogs: Map<string, DialogEntry>
  resolvedDialogs: Set<string>
  tools: Map<string, ToolStatus>
  assistant: { id: string; blocks: Map<number, string> } | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function textBlocks(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  return content.flatMap((block) => { const item = record(block); return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [] }).join('\n\n')
}
function messageText(blocks: Map<number, string>): string {
  return [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('\n\n')
}

export class ChatController {
  private snapshot: Snapshot
  private connection: Connection | null = null
  private listeners = new Set<() => void>()
  private readonly tokens = new Map<string, string>()
  private readonly storage: Storage | null
  private readonly transportFactory: TransportFactory
  private writesAllowed: boolean

  constructor(storage: Storage | null = browserStorage(), transportFactory: TransportFactory = openPiTransport) {
    this.storage = storage
    this.transportFactory = transportFactory
    const loaded = loadData(storage)
    this.writesAllowed = loaded.canWrite
    this.snapshot = { data: loaded.data, status: 'disconnected', notice: null, storageWarning: loaded.warning, currentSessionId: null, canSend: false, canStop: false, canReset: false, busy: false, runLabel: null, dialogs: [], tools: [] }
    if (loaded.canWrite) {
      if (!this.persist(loaded.data)) this.snapshot.storageWarning = STORAGE_WARNING
      else if (loaded.migrated) {
        try { storage?.removeItem(LEGACY_STORAGE_KEY) } catch { this.snapshot.storageWarning = 'Migrated data was saved, but old browser storage could not be removed.' }
      }
    }
  }
  getSnapshot = (): Snapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  hasToken(id: string): boolean { return this.tokens.has(id) }

  private publish(patch: Partial<Snapshot> = {}) {
    const c = this.connection
    const status = patch.status ?? this.snapshot.status
    const ready = !!c?.ready && status === 'connected'
    const pending = c?.pending.size ?? 0
    const hasDialogs = (c?.dialogs.size ?? 0) > 0
    const busy = !!c && (c.running || !!c.prompt)
    const abortPending = !!c && [...c.pending.values()].some((item) => item.type === 'abort')
    const resetPending = !!c && [...c.pending.values()].some((item) => item.type === 'new_session')
    this.snapshot = {
      ...this.snapshot, ...patch,
      canSend: ready && !busy && !hasDialogs && pending === 0,
      canReset: ready && !busy && !hasDialogs && pending === 0,
      canStop: ready && busy && !abortPending && !resetPending,
      busy: busy || resetPending,
      runLabel: c?.runLabel ?? null,
      dialogs: c ? [...c.dialogs.values()].map((item) => item.dialog) : [],
      tools: c ? [...c.tools.values()] : [],
    }
    this.listeners.forEach((listener) => listener())
  }
  private persist(data: StoredData): boolean {
    try { if (!this.storage || !this.writesAllowed) return false; this.storage.setItem(STORAGE_KEY, JSON.stringify(data)); return true } catch { return false }
  }
  private setData(data: StoredData) {
    const saved = this.persist(data)
    this.publish({ data, storageWarning: saved ? this.snapshot.storageWarning : STORAGE_WARNING })
  }
  private updateMessages(id: string, transform: (messages: Message[]) => Message[]) {
    const data = this.snapshot.data
    this.setData({ ...data, conversations: { ...data.conversations, [id]: transform(data.conversations[id] ?? []) } })
  }
  private markRun(c: Connection, active: boolean, sessionId = c.sessionId) {
    const data = this.snapshot.data
    if (active && data.activeRuns[c.backendId] === sessionId) return
    if (!active && !data.activeRuns[c.backendId]) return
    const activeRuns = { ...data.activeRuns }
    if (active) activeRuns[c.backendId] = sessionId
    else delete activeRuns[c.backendId]
    this.setData({ ...data, activeRuns })
  }
  private append(c: Connection, message: Message) { this.updateMessages(c.backendId, (items) => [...items, message]) }
  private patchMessage(c: Connection, id: string, patch: Partial<Message>) {
    this.updateMessages(c.backendId, (items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))
  }
  private endConnection(status: ConnectionStatus, notice: string | null) {
    const c = this.connection
    this.connection = null
    const hadPending = !!c && c.pending.size > 0
    if (c) {
      c.abortController.abort()
      try { c.transport?.close() } catch { /* Already closed. */ }
      for (const pending of c.pending.values()) clearTimeout(pending.timer)
      for (const item of c.dialogs.values()) if (item.timer) clearTimeout(item.timer)
      const unknownIds = new Set([...c.pending.values()].flatMap((pending) => pending.type === 'prompt' && pending.messageId ? [pending.messageId] : []))
      const unsettled = c.running || (!!c.prompt && c.prompt.responseReceived && !c.prompt.sawSettlement)
      const data = this.snapshot.data
      const activeRuns = { ...data.activeRuns }
      const activitySession = activeRuns[c.backendId] ?? c.sessionId
      delete activeRuns[c.backendId]
      const updated = (data.conversations[c.backendId] ?? []).map((item): Message => {
        if (unknownIds.has(item.id)) return { ...item, status: 'unknown' }
        if ((item.sessionId === c.sessionId || item.id === c.assistant?.id) && item.status === 'pending') return { ...item, status: item.role === 'user' ? 'unknown' : 'interrupted' }
        return item
      })
      if (unsettled) updated.push({ id: newId(), sessionId: activitySession, role: 'system', content: 'Agent activity ended before settlement; side effects may have occurred.', status: 'interrupted' })
      this.setData({ ...data, activeRuns, conversations: { ...data.conversations, [c.backendId]: updated } })
    }
    this.publish({ status, notice: hadPending ? `${notice ?? 'Disconnected.'} Pending command outcomes are unknown.` : notice, currentSessionId: null })
  }

  selectBackend(id: string) {
    if (!this.snapshot.data.backends.some((item) => item.id === id) || this.snapshot.data.selectedBackendId === id) return
    this.endConnection('disconnected', null)
    this.setData({ ...this.snapshot.data, selectedBackendId: id })
  }
  addBackend(name: string, inputUrl: string, maxBytes = DEFAULT_MAX_BYTES) {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Enter a backend name.')
    const backend: Backend = { id: newId(), name: trimmed, url: normalizeUrl(inputUrl), maxMessageBytes: validMaxBytes(maxBytes), needsReview: false }
    this.endConnection('disconnected', null)
    const data = this.snapshot.data
    this.setData({ ...data, backends: [...data.backends, backend], selectedBackendId: backend.id })
  }
  updateBackend(id: string, name: string, inputUrl: string, maxBytes = DEFAULT_MAX_BYTES) {
    const existing = this.snapshot.data.backends.find((item) => item.id === id)
    if (!existing) throw new Error('Backend no longer exists.')
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Enter a backend name.')
    const url = normalizeUrl(inputUrl)
    const limit = validMaxBytes(maxBytes)
    const changedUrl = existing.url !== url
    if (changedUrl) {
      if (this.connection?.backendId === id) this.endConnection('disconnected', null)
      this.tokens.delete(id)
    }
    // The limit is part of the transport, so reconnect if it changes.
    if (!changedUrl && existing.maxMessageBytes !== limit && this.connection?.backendId === id) this.endConnection('disconnected', 'Message limit changed. Reconnect to start a fresh session.')
    const data = this.snapshot.data
    const conversations = { ...data.conversations }
    if (changedUrl) delete conversations[id]
    this.setData({ ...data, backends: data.backends.map((item) => item.id === id ? { ...item, name: trimmed, url, maxMessageBytes: limit, needsReview: false } : item), conversations })
  }
  removeBackend(id: string) {
    if (this.connection?.backendId === id) this.endConnection('disconnected', null)
    this.tokens.delete(id)
    const data = this.snapshot.data
    const backends = data.backends.filter((item) => item.id !== id)
    const conversations = { ...data.conversations }; delete conversations[id]
    const activeRuns = { ...data.activeRuns }; delete activeRuns[id]
    this.setData({ ...data, backends, conversations, activeRuns, selectedBackendId: data.selectedBackendId === id ? backends[0]?.id ?? null : data.selectedBackendId })
  }
  clearHistory(id: string) {
    if (this.connection?.backendId === id) return
    const data = this.snapshot.data
    const conversations = { ...data.conversations }; delete conversations[id]
    this.setData({ ...data, conversations })
  }

  async connect(token?: string, allowInsecure = false): Promise<void> {
    const backend = this.snapshot.data.backends.find((item) => item.id === this.snapshot.data.selectedBackendId)
    if (!backend) return
    if (backend.needsReview) { this.publish({ notice: 'Review and save this migrated backend before connecting.' }); return }
    if (isInsecureRemote(backend.url) && !allowInsecure) { this.publish({ notice: 'Confirm the insecure HTTP connection before sending a token.' }); return }
    const secret = token || this.tokens.get(backend.id)
    if (!secret || /\s/.test(secret)) { this.publish({ notice: 'Enter a nonempty bearer token without whitespace.' }); return }
    this.tokens.set(backend.id, secret)
    this.endConnection('disconnected', null)
    const c: Connection = { backendId: backend.id, sessionId: newId(), transport: null, abortController: new AbortController(), ready: false, running: false, runLabel: null, prompt: null, echo: null, pending: new Map(), dialogs: new Map(), resolvedDialogs: new Set(), tools: new Map(), assistant: null }
    this.connection = c
    this.publish({ status: 'connecting', notice: 'Connecting to a fresh Pi session…', currentSessionId: c.sessionId })
    try {
      const transport = await this.transportFactory(backend.url, secret, backend.maxMessageBytes, {
        onOpen: () => { if (this.connection === c) this.publish({ notice: 'Socket open; waiting for Pi readiness…' }) },
        onError: () => { if (this.connection === c) this.endConnection('error', 'WebSocket connection failed. Check the endpoint, origin, and server logs.') },
        onClose: (code) => { if (this.connection === c) this.endConnection('disconnected', `Connection closed (${code}). Reconnecting creates a fresh session.`) },
        onProtocolError: (message) => { if (this.connection === c) this.endConnection('error', `Protocol error: ${message}`) },
        onFrame: (frame) => { if (this.connection === c) this.handleFrame(c, frame) },
      }, c.abortController.signal)
      if (this.connection !== c) { transport.close(); return }
      c.transport = transport
    } catch (error) {
      if (this.connection === c) this.endConnection('error', error instanceof Error ? error.message : 'Connection failed.')
    }
  }
  disconnect() { this.endConnection('disconnected', 'Disconnected. Reconnecting creates a fresh session.') }

  private addPending(c: Connection, id: string, type: CommandType, extra: Partial<Pending> = {}) {
    const pending: Pending = { type, timedOut: false, ...extra, timer: setTimeout(() => {
      if (this.connection !== c || c.pending.get(id) !== pending) return
      pending.timedOut = true
      if (pending.messageId) this.patchMessage(c, pending.messageId, { status: 'unknown' })
      this.publish({ notice: `${type === 'new_session' ? 'Session reset' : type === 'abort' ? 'Stop request' : 'Prompt'} timed out; its outcome is unknown. Wait for a response or disconnect; do not resend.` })
    }, COMMAND_TIMEOUT) }
    c.pending.set(id, pending)
  }
  send(content: string): boolean {
    const c = this.connection
    if (!c?.transport || !this.snapshot.canSend || !content.trim()) return false
    const id = newId()
    const frame: ClientFrame = { type: 'prompt', id, message: content }
    const backend = this.snapshot.data.backends.find((item) => item.id === c.backendId)!
    try { serializeClientFrame(frame, backend.maxMessageBytes) } catch (error) { this.publish({ notice: error instanceof Error ? error.message : 'Invalid message.' }); return false }
    const messageId = newId()
    c.prompt = { id, messageId, responseReceived: false, sawSettlement: false }
    c.echo = { id, text: content, reconciled: false }
    this.addPending(c, id, 'prompt', { messageId })
    this.append(c, { id: messageId, sessionId: c.sessionId, role: 'user', content, status: 'pending' })
    this.publish({ notice: null })
    try { c.transport.send(frame); return true } catch {
      this.endConnection('error', 'Could not send the prompt. Its outcome is unknown; reconnect without replaying.')
      return false
    }
  }
  stop() {
    const c = this.connection
    if (!c?.transport || !this.snapshot.canStop) return
    const id = newId(); const frame: ClientFrame = { type: 'abort', id }
    try { serializeClientFrame(frame, this.snapshot.data.backends.find((item) => item.id === c.backendId)!.maxMessageBytes) } catch (error) { this.publish({ notice: error instanceof Error ? error.message : 'Invalid stop request.' }); return }
    this.addPending(c, id, 'abort')
    try { c.transport.send(frame); c.runLabel = 'Stopping…'; this.publish({ notice: null }) }
    catch { this.endConnection('error', 'Could not request stop; its outcome is unknown.') }
  }
  newSession() {
    const c = this.connection
    if (!c?.transport || !this.snapshot.canReset) return
    const id = newId(); const frame: ClientFrame = { type: 'new_session', id }
    try { serializeClientFrame(frame, this.snapshot.data.backends.find((item) => item.id === c.backendId)!.maxMessageBytes) } catch (error) { this.publish({ notice: error instanceof Error ? error.message : 'Invalid session request.' }); return }
    this.addPending(c, id, 'new_session', { oldMessageIds: new Set((this.snapshot.data.conversations[c.backendId] ?? []).map((item) => item.id)) })
    try { c.transport.send(frame); this.publish({ notice: 'Requesting a new session…' }) }
    catch { this.endConnection('error', 'Could not request a new session; its outcome is unknown.') }
  }

  private response(c: Connection, frame: Frame) {
    if (typeof frame.id !== 'string' || typeof frame.command !== 'string' || typeof frame.success !== 'boolean') { this.publish({ notice: 'Malformed command response; outcome remains unknown.' }); return }
    const pending = c.pending.get(frame.id)
    if (!pending) return
    if (frame.command !== pending.type) { this.publish({ notice: 'Mismatched command response; outcome remains unknown.' }); return }
    const data = record(frame.data)
    if (frame.success && pending.type === 'prompt' && !['started', 'queued', 'handled'].includes(String(data?.disposition))) { this.publish({ notice: 'Malformed prompt response; outcome remains unknown.' }); return }
    if (frame.success && pending.type === 'new_session' && typeof data?.cancelled !== 'boolean') { this.publish({ notice: 'Malformed session response; outcome remains unknown.' }); return }
    clearTimeout(pending.timer); c.pending.delete(frame.id)
    if (pending.type === 'prompt') {
      const prompt = c.prompt?.id === frame.id ? c.prompt : null
      if (pending.messageId) this.patchMessage(c, pending.messageId, { status: frame.success ? 'complete' : 'failed', error: !frame.success && typeof frame.error === 'string' ? frame.error : undefined })
      if (!frame.success && c.echo?.id === frame.id) c.echo = null
      if (prompt) {
        prompt.responseReceived = true
        if (!frame.success || data?.disposition === 'handled' || prompt.sawSettlement) c.prompt = null
        else { this.markRun(c, true); c.runLabel = data?.disposition === 'queued' ? 'Prompt queued by Pi…' : 'Waiting for agent…' }
      }
      this.publish({ notice: !frame.success ? `Prompt rejected${typeof frame.error === 'string' ? `: ${frame.error}` : '.'}` : data?.disposition === 'handled' ? 'Prompt handled by an extension.' : null })
    } else if (pending.type === 'new_session') {
      if (frame.success && data?.cancelled === false) {
        const newSessionId = newId()
        const uncertainId = `unknown-${newId()}`
        let retained = false
        this.updateMessages(c.backendId, (items) => items.filter((item) => !pending.oldMessageIds?.has(item.id)).map((item) => { retained = true; return { ...item, sessionId: uncertainId } }))
        c.sessionId = newSessionId
        if (c.running) this.markRun(c, true, uncertainId)
        c.echo = null
        this.publish({ currentSessionId: newSessionId, notice: retained ? 'New session started. Activity received during reset has uncertain session context.' : 'New session started.' })
      } else this.publish({ notice: frame.success ? 'New session cancelled; history retained.' : `New session failed${typeof frame.error === 'string' ? `: ${frame.error}` : '; history retained.'}` })
    } else {
      const stillRunning = c.running || (!!c.prompt && !c.prompt.sawSettlement)
      c.runLabel = stillRunning ? (frame.success ? 'Stopping…' : 'Agent working…') : null
      this.publish({ notice: frame.success ? (stillRunning ? 'Stop requested; waiting for the agent to settle.' : 'Agent settled.') : `Stop failed${typeof frame.error === 'string' ? `: ${frame.error}` : '.'}` })
    }
  }

  private handleFrame(c: Connection, frame: Frame) {
    if (frame.type === 'server_ready') {
      if (frame.protocolVersion !== 1 || typeof frame.connectionId !== 'string') { this.endConnection('error', 'Unsupported or malformed server readiness frame.'); return }
      if (!c.ready) { c.ready = true; this.publish({ status: 'connected', notice: 'Connected to a fresh session. Earlier history is not available to the agent.' }) }
      return
    }
    if (frame.type === 'extension_ui_request') { this.extensionRequest(c, frame); return }
    if (frame.type === 'server_error') {
      const labels: Record<string, string> = { INVALID_COMMAND: 'The server rejected a command or dialog response.', PI_UNAVAILABLE: 'Pi is unavailable.', TOOL_TIMEOUT: 'A tool timed out.', IDLE_TIMEOUT: 'The session timed out due to inactivity.' }
      this.publish({ notice: typeof frame.code === 'string' ? labels[frame.code] ?? 'The server reported a protocol error.' : 'The server reported a protocol error.' }); return
    }
    if (frame.type === 'response') { this.response(c, frame); return }
    if (frame.type === 'agent_start') { c.running = true; c.runLabel = 'Agent working…'; this.markRun(c, true); this.publish(); return }
    if (frame.type === 'agent_end') { c.runLabel = 'Finishing agent work…'; this.publish(); return }
    if (frame.type === 'agent_settled') {
      c.running = false; c.runLabel = null
      this.markRun(c, false)
      if (c.assistant) { this.patchMessage(c, c.assistant.id, { status: frame.aborted === true ? 'cancelled' : 'interrupted' }); c.assistant = null }
      c.tools.clear(); c.echo = null
      if (c.prompt) { c.prompt.sawSettlement = true; if (c.prompt.responseReceived) c.prompt = null }
      this.publish({ notice: frame.aborted === true ? 'Agent run was cancelled.' : this.snapshot.notice }); return
    }
    if (frame.type === 'auto_retry_start' || frame.type === 'summarization_retry_scheduled') { c.runLabel = 'Retrying…'; this.publish(); return }
    if (frame.type === 'compaction_start') { c.runLabel = 'Compacting context…'; this.publish(); return }
    if (frame.type === 'compaction_end' || frame.type === 'auto_retry_end' || frame.type === 'summarization_retry_finished') { c.runLabel = 'Agent working…'; this.publish(); return }
    if (frame.type === 'extension_error') { this.publish({ notice: 'An extension reported an error.' }); return }
    if (frame.type === 'tool_execution_start' || frame.type === 'tool_execution_update' || frame.type === 'tool_execution_end') {
      if (typeof frame.toolCallId !== 'string') return
      const previous = c.tools.get(frame.toolCallId)
      const name = typeof frame.toolName === 'string' ? frame.toolName : previous?.name ?? 'Tool'
      c.tools.set(frame.toolCallId, { id: frame.toolCallId, name, state: frame.type === 'tool_execution_end' ? frame.isError === true ? 'failed' : 'complete' : 'running' }); this.publish(); return
    }
    if (frame.type === 'message_start') {
      const message = record(frame.message)
      if (message?.role !== 'assistant') return
      if (c.assistant) this.patchMessage(c, c.assistant.id, { status: 'interrupted' })
      const id = newId(); c.assistant = { id, blocks: new Map() }
      this.append(c, { id, sessionId: c.sessionId, role: 'assistant', content: '', status: 'pending' }); return
    }
    if (frame.type === 'message_update') {
      const event = record(frame.assistantMessageEvent)
      if (!event || !c.assistant) return
      if ((event.type === 'text_delta' || event.type === 'text_end') && Number.isSafeInteger(event.contentIndex) && (event.contentIndex as number) >= 0) {
        const index = event.contentIndex as number
        if (event.type === 'text_delta' && typeof event.delta === 'string') c.assistant.blocks.set(index, (c.assistant.blocks.get(index) ?? '') + event.delta)
        else if (event.type === 'text_end' && typeof event.content === 'string') c.assistant.blocks.set(index, event.content)
        else return
        this.patchMessage(c, c.assistant.id, { content: messageText(c.assistant.blocks) })
      }
      return
    }
    if (frame.type === 'message_end') {
      const message = record(frame.message)
      if (!message) return
      if (message.role === 'user') {
        const text = textBlocks(message.content)
        if (text === null) return
        if (c.echo && !c.echo.reconciled && c.echo.text === text) c.echo.reconciled = true
        else this.append(c, { id: newId(), sessionId: c.sessionId, role: 'backend', content: text, status: 'complete' })
      } else if (message.role === 'assistant') {
        const content = textBlocks(message.content)
        if (content === null) { this.publish({ notice: 'Malformed assistant message; waiting for the agent.' }); return }
        const status: Message['status'] = message.stopReason === 'error' ? 'failed' : message.stopReason === 'aborted' ? 'cancelled' : 'complete'
        const error = typeof message.errorMessage === 'string' ? message.errorMessage : undefined
        if (c.assistant) {
          const id = c.assistant.id; c.assistant = null
          if (!content && status === 'complete') this.updateMessages(c.backendId, (items) => items.filter((item) => item.id !== id))
          else this.patchMessage(c, id, { content, status, error })
        } else if (content || status !== 'complete') this.append(c, { id: newId(), sessionId: c.sessionId, role: 'assistant', content, status, error })
      }
    }
  }

  private extensionRequest(c: Connection, frame: Frame) {
    if (frame.method === 'notify') { if (typeof frame.message === 'string') this.publish({ notice: frame.message }); return }
    if (frame.method !== 'select' && frame.method !== 'confirm' && frame.method !== 'input' && frame.method !== 'editor') return
    if (typeof frame.id !== 'string' || !frame.id || frame.id.length > 128 || c.dialogs.has(frame.id) || c.resolvedDialogs.has(frame.id)) { this.publish({ notice: 'Invalid extension dialog.' }); return }
    if (frame.method === 'select' && (!Array.isArray(frame.options) || !frame.options.every((item) => typeof item === 'string'))) { this.publish({ notice: 'Invalid extension selection dialog.' }); return }
    const dialog: ExtensionDialog = { id: frame.id, method: frame.method, title: typeof frame.title === 'string' ? frame.title : 'Extension request' }
    if (typeof frame.message === 'string') dialog.message = frame.message
    if (Array.isArray(frame.options)) dialog.options = frame.options as string[]
    if (typeof frame.placeholder === 'string') dialog.placeholder = frame.placeholder
    if (typeof frame.prefill === 'string') dialog.prefill = frame.prefill
    const item: DialogEntry = { dialog }
    if (typeof frame.timeout === 'number' && Number.isFinite(frame.timeout) && frame.timeout > 0) {
      const timeout = Math.min(frame.timeout, 2147483647)
      dialog.deadline = Date.now() + timeout
      item.timer = setTimeout(() => { if (this.connection === c && c.dialogs.get(dialog.id) === item) { c.dialogs.delete(dialog.id); c.resolvedDialogs.add(dialog.id); this.publish({ notice: 'An extension dialog expired.' }) } }, timeout)
    }
    c.dialogs.set(dialog.id, item); this.publish()
  }
  replyDialog(id: string, answer: { value: string } | { confirmed: boolean } | { cancelled: true }): boolean {
    const c = this.connection; const item = c?.dialogs.get(id)
    if (!c?.transport || !item) return false
    const dialog = item.dialog
    if (dialog.deadline !== undefined && Date.now() >= dialog.deadline) { if (item.timer) clearTimeout(item.timer); c.dialogs.delete(id); c.resolvedDialogs.add(id); this.publish({ notice: 'The extension dialog expired.' }); return false }
    if (Object.keys(answer).length !== 1) return false
    if ('value' in answer && (typeof answer.value !== 'string' || dialog.method === 'confirm' || (dialog.method === 'select' && !dialog.options?.includes(answer.value)))) return false
    if ('confirmed' in answer && (typeof answer.confirmed !== 'boolean' || dialog.method !== 'confirm')) return false
    if ('cancelled' in answer && answer.cancelled !== true) return false
    if (!('value' in answer) && !('confirmed' in answer) && !('cancelled' in answer)) return false
    const frame: DialogReply = { type: 'extension_ui_response', id, ...answer }
    try {
      serializeClientFrame(frame, this.snapshot.data.backends.find((backend) => backend.id === c.backendId)!.maxMessageBytes)
      c.transport.send(frame)
    } catch (error) { this.publish({ notice: error instanceof Error ? error.message : 'Could not send dialog response.' }); return false }
    if (item.timer) clearTimeout(item.timer)
    c.dialogs.delete(id); c.resolvedDialogs.add(id); this.publish(); return true
  }
}
