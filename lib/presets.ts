export interface Preset {
  id: string
  name: string
  rounds: number
  roundSeconds: number
  restSeconds: number
  createdAt: number
}

const STORAGE_KEY = 'boxing_timer_presets_v1'

export function loadPresets(): Preset[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p: any) => p && typeof p?.id === 'string')
  } catch {
    return []
  }
}

export function savePresets(presets: Preset[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets ?? []))
  } catch {
    // ignore
  }
}

export function formatSeconds(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds ?? 0))
  const m = Math.floor(safe / 60)
  const s = safe % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export const DEFAULT_PRESETS: Preset[] = [
  { id: 'default-classic', name: 'Classic 3-min rounds', rounds: 12, roundSeconds: 180, restSeconds: 60, createdAt: 0 },
  { id: 'default-amateur', name: 'Amateur 2-min rounds', rounds: 3, roundSeconds: 120, restSeconds: 60, createdAt: 0 },
  { id: 'default-speed', name: 'Speed work 1-min', rounds: 10, roundSeconds: 60, restSeconds: 30, createdAt: 0 },
]
