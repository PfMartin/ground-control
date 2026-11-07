import { beforeEach, describe, expect, it } from 'vitest'
import { ChatController } from './controller'
import { isInsecureRemote, LEGACY_STORAGE_KEY, normalizeUrl, STORAGE_KEY, validMaxBytes } from './storage'

describe('backend configuration and migration', () => {
  beforeEach(() => localStorage.clear())
  it('normalizes prefixes and rejects unsafe endpoint components', () => {
    expect(normalizeUrl('https://example.test/pi')).toBe('https://example.test/pi/')
    expect(normalizeUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/')
    for (const url of ['ws://example.test', 'https://u:p@example.test', 'https://example.test/?token=secret', 'https://example.test/#', 'https://example.test/?']) expect(() => normalizeUrl(url)).toThrow()
    expect(isInsecureRemote('http://127.0.0.1:8080/')).toBe(false)
    expect(isInsecureRemote('http://[::1]:8080/')).toBe(false)
    expect(isInsecureRemote('http://example.test/')).toBe(true)
    expect(isInsecureRemote('https://example.test/')).toBe(false)
    expect(() => validMaxBytes(0)).toThrow()
    expect(() => validMaxBytes(1.5)).toThrow()
  })
  it('does not delete legacy data when the new version cannot be saved', () => {
    const old = JSON.stringify({ version: 1, backends: [{ id: 'a', name: 'Old', url: 'ws://localhost:8787/' }], selectedBackendId: 'a', conversations: {} })
    const map = new Map([[LEGACY_STORAGE_KEY, old]])
    const storage: Storage = {
      get length() { return map.size }, clear: () => map.clear(), getItem: (key) => map.get(key) ?? null,
      key: (index) => [...map.keys()][index] ?? null, removeItem: (key) => { map.delete(key) },
      setItem: () => { throw new Error('quota exceeded') },
    }
    const controller = new ChatController(storage)
    expect(controller.getSnapshot().data.backends[0].url).toBe('http://localhost:8787/')
    expect(controller.getSnapshot().storageWarning).toBeTruthy()
    expect(map.get(LEGACY_STORAGE_KEY)).toBe(old)
    expect(map.has(STORAGE_KEY)).toBe(false)
  })
  it('retains the legacy key if cleanup fails after a successful migration', () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ version: 1, backends: [], selectedBackendId: null, conversations: {} }))
    const storage: Storage = { get length() { return localStorage.length }, clear: () => localStorage.clear(), getItem: (key) => localStorage.getItem(key), key: (index) => localStorage.key(index), setItem: (key, value) => localStorage.setItem(key, value), removeItem: () => { throw new Error('blocked') } }
    const controller = new ChatController(storage)
    expect(localStorage.getItem(STORAGE_KEY)).toBeTruthy()
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeTruthy()
    expect(controller.getSnapshot().storageWarning).toContain('could not be removed')
  })
})
