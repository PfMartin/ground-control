export type Frame = Record<string, unknown> & { type: string }
export type Command =
  | { type: 'prompt'; id: string; message: string }
  | { type: 'abort'; id: string }
  | { type: 'new_session'; id: string }
export type DialogReply =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true }
export type ClientFrame = Command | DialogReply
export const MAX_TEXT_LENGTH = 131072

export function serializeClientFrame(frame: ClientFrame, maxBytes: number): string {
  if (typeof frame.id !== 'string' || frame.id.length < 1 || frame.id.length > 128) throw new Error('Invalid command ID.')
  if ('message' in frame && (frame.message.length < 1 || frame.message.length > MAX_TEXT_LENGTH)) throw new Error('Message exceeds the server’s text limit.')
  if ('value' in frame && frame.value.length > MAX_TEXT_LENGTH) throw new Error('Response exceeds the server’s text limit.')
  const text = JSON.stringify(frame)
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error(`Message exceeds this backend’s ${maxBytes}-byte limit.`)
  return text
}

export function parseServerFrame(raw: unknown): Frame {
  if (typeof raw !== 'string') throw new Error('Expected a text frame.')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('Invalid JSON frame.') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).type !== 'string') throw new Error('Invalid server frame.')
  return value as Frame
}
