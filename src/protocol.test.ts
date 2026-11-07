import { describe, expect, it } from 'vitest'
import { parseServerFrame, serializeClientFrame } from './protocol'

describe('pi-rpc-v1 framing', () => {
  it('sends one strict command and counts serialized UTF-8 bytes', () => {
    const frame = { type: 'prompt', id: 'a', message: '**Hi** 😀' } as const
    const text = serializeClientFrame(frame, 1000)
    expect(JSON.parse(text)).toEqual(frame)
    expect(() => serializeClientFrame(frame, text.length)).toThrow(/byte limit/)
    expect(serializeClientFrame(frame, new TextEncoder().encode(text).length)).toBe(text)
    expect(() => serializeClientFrame({ type: 'prompt', id: 'a', message: 'x'.repeat(131073) }, 999999)).toThrow(/text limit/)
    expect(() => serializeClientFrame({ type: 'extension_ui_response', id: 'a', value: 'x'.repeat(131073) }, 999999)).toThrow(/text limit/)
    expect(() => serializeClientFrame({ type: 'abort', id: '' }, 1000)).toThrow(/ID/)
  })
  it('accepts unknown types and fields but rejects invalid frames', () => {
    expect(parseServerFrame('{"type":"future","extra":42}')).toEqual({ type: 'future', extra: 42 })
    for (const value of [null, '{}', 'nope', '[]', '{"type":1}']) expect(() => parseServerFrame(value)).toThrow()
  })
})
