/**
 * Saved workout presets (Boxing, MMA, and custom structures).
 *
 * Storage evolution: presets were originally persisted under
 * `boxing_timer_presets_v1` with no workout type and no prep duration. The v2
 * shape adds `type` and `prepSeconds`, so `loadPresets()` performs a one-time
 * `v1 -> v2` migration on first load and thereafter reads `v2` verbatim
 * (requirements 5.10, 5.11, 5.12).
 */

export type WorkoutType = 'BOXING' | 'MMA' | 'CUSTOM'

export interface Preset {
  id: string
  name: string
  /** Workout family. Legacy (v1) records migrate to `BOXING`. */
  type: WorkoutType
  rounds: number
  roundSeconds: number
  restSeconds: number
  /** Lead-in countdown before round 1. Defaults to {@link DEFAULT_PREP_SECONDS}. */
  prepSeconds?: number
  createdAt: number
}

/** The v1 key, read once by the migration and then left alone. */
export const LEGACY_STORAGE_KEY = 'boxing_timer_presets_v1'

/** The current key. All writes go here. */
export const STORAGE_KEY = 'boxing_timer_presets_v2'

/** Prep duration assigned to migrated and untyped records (requirement 5.10). */
export const DEFAULT_PREP_SECONDS = 5

/** Workout type assumed for any record without one (requirement 5.12). */
export const DEFAULT_WORKOUT_TYPE: WorkoutType = 'BOXING'

const WORKOUT_TYPES: readonly WorkoutType[] = ['BOXING', 'MMA', 'CUSTOM']

export function isWorkoutType(value: unknown): value is WorkoutType {
  return typeof value === 'string' && (WORKOUT_TYPES as readonly string[]).includes(value)
}

/**
 * Coerce an arbitrary stored record into a well-formed `Preset`, or `null` when
 * it carries no usable identity. A missing/unknown `type` becomes `BOXING` and a
 * missing/invalid `prepSeconds` becomes 5 — the record itself is not rewritten.
 */
function normalizePreset(raw: any): Preset | null {
  if (!raw || typeof raw?.id !== 'string') return null
  const prep = Number(raw?.prepSeconds)
  return {
    id: raw.id,
    name: typeof raw?.name === 'string' ? raw.name : 'Untitled',
    type: isWorkoutType(raw?.type) ? raw.type : DEFAULT_WORKOUT_TYPE,
    rounds: Number.isFinite(Number(raw?.rounds)) ? Number(raw.rounds) : 1,
    roundSeconds: Number.isFinite(Number(raw?.roundSeconds)) ? Number(raw.roundSeconds) : 0,
    restSeconds: Number.isFinite(Number(raw?.restSeconds)) ? Number(raw.restSeconds) : 0,
    prepSeconds: Number.isFinite(prep) && prep >= 0 ? prep : DEFAULT_PREP_SECONDS,
    createdAt: Number.isFinite(Number(raw?.createdAt)) ? Number(raw.createdAt) : 0,
  }
}

function readKey(key: string): unknown[] | null {
  const raw = window.localStorage.getItem(key)
  if (raw === null) return null
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : []
}

/**
 * Load the saved presets, migrating `v1` records to `v2` the first time.
 *
 * Returns `[]` (and writes nothing) when storage is unavailable, unreadable, or
 * full — the same catch-and-no-op behavior the v1 implementation had.
 */
export function loadPresets(): Preset[] {
  if (typeof window === 'undefined') return []
  try {
    // Once v2 exists — even as an empty list — it is the single source of truth
    // and is never rewritten on load (requirement 5.11).
    const current = readKey(STORAGE_KEY)
    if (current !== null) {
      return current.map(normalizePreset).filter((p): p is Preset => p !== null)
    }

    const legacy = readKey(LEGACY_STORAGE_KEY)
    if (legacy === null) return []

    // One-time v1 -> v2 migration: preserve id/name/rounds/roundSeconds/
    // restSeconds/createdAt, assign BOXING and 5 s prep (requirement 5.10).
    const migrated: Preset[] = legacy
      .map(normalizePreset)
      .filter((p): p is Preset => p !== null)

    savePresets(migrated)
    return migrated
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

/** Short display label for a workout type, used by preset rows and badges. */
export function workoutTypeLabel(type: WorkoutType | undefined): string {
  switch (type) {
    case 'MMA':
      return 'MMA'
    case 'CUSTOM':
      return 'Custom'
    default:
      return 'Boxing'
  }
}

/** Requirements 5.3 (Boxing defaults) and 5.4 (MMA defaults). */
export const DEFAULT_PRESETS: Preset[] = [
  // Boxing
  { id: 'default-classic', name: 'Boxing — Classic 12×3', type: 'BOXING', rounds: 12, roundSeconds: 180, restSeconds: 60, prepSeconds: 5, createdAt: 0 },
  { id: 'default-amateur', name: 'Boxing — Amateur 3×2', type: 'BOXING', rounds: 3, roundSeconds: 120, restSeconds: 60, prepSeconds: 5, createdAt: 0 },
  { id: 'default-speed', name: 'Boxing — Speed 10×1', type: 'BOXING', rounds: 10, roundSeconds: 60, restSeconds: 30, prepSeconds: 5, createdAt: 0 },
  // MMA
  { id: 'default-mma-champ', name: 'MMA — Championship 5×5', type: 'MMA', rounds: 5, roundSeconds: 300, restSeconds: 60, prepSeconds: 10, createdAt: 0 },
  { id: 'default-mma-reg', name: 'MMA — Regular 3×5', type: 'MMA', rounds: 3, roundSeconds: 300, restSeconds: 60, prepSeconds: 10, createdAt: 0 },
]
