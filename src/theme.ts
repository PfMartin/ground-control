import { browserStorage } from './storage'

export type Theme = 'light' | 'ssp'
export const THEME_STORAGE_KEY = 'ground-control:theme'

export function loadTheme(): Theme {
  try { return browserStorage()?.getItem(THEME_STORAGE_KEY) === 'ssp' ? 'ssp' : 'light' } catch { return 'light' }
}

export function saveTheme(theme: Theme): boolean {
  try {
    const storage = browserStorage()
    if (!storage) return false
    storage.setItem(THEME_STORAGE_KEY, theme)
    return true
  } catch { return false }
}
