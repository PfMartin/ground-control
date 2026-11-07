export type Role = 'user' | 'assistant' | 'backend' | 'system'
export type MessageStatus = 'pending' | 'complete' | 'interrupted' | 'failed' | 'unknown' | 'cancelled'

export interface Backend {
  id: string
  name: string
  /** HTTP(S) base URL, ending in a slash. */
  url: string
  maxMessageBytes: number
  needsReview: boolean
}

export interface Message {
  id: string
  sessionId: string
  role: Role
  content: string
  status: MessageStatus
  error?: string
}

export interface StoredData {
  version: 2
  backends: Backend[]
  selectedBackendId: string | null
  conversations: Record<string, Message[]>
  /** Persisted only to recognize a run interrupted by tab reload or crash. */
  activeRuns: Record<string, string>
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
export type DialogMethod = 'select' | 'confirm' | 'input' | 'editor'
export interface ExtensionDialog {
  id: string
  method: DialogMethod
  title: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  deadline?: number
}
export interface ToolStatus { id: string; name: string; state: 'running' | 'complete' | 'failed' }

export interface Snapshot {
  data: StoredData
  status: ConnectionStatus
  notice: string | null
  storageWarning: string | null
  currentSessionId: string | null
  canSend: boolean
  canStop: boolean
  canReset: boolean
  busy: boolean
  runLabel: string | null
  dialogs: ExtensionDialog[]
  tools: ToolStatus[]
}
