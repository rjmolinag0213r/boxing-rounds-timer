import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_PRESETS,
  DEFAULT_PREP_SECONDS,
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  loadPresets,
  savePresets,
  type Preset,
} from '@/lib/presets'

/** A v1-shaped record: no `type`, no `prepSeconds`. */
const legacyRecord = {
  id: 'legacy-1',
  name: 'My old workout',
  rounds: 8,
  roundSeconds: 150,
  restSeconds: 45,
  createdAt: 1_700_000_000_000,
}

describe('preset defaults (requirements 5.3, 5.4)', () => {
  it('provides the three typed Boxing defaults with 5 s prep', () => {
    const boxing = DEFAULT_PRESETS.filter((p) => p.type === 'BOXING')
    expect(boxing).toHaveLength(3)
    expect(boxing.every((p) => p.prepSeconds === 5)).toBe(true)
    expect(boxing.map((p) => [p.rounds, p.roundSeconds, p.restSeconds])).toEqual([
      [12, 180, 60],
      [3, 120, 60],
      [10, 60, 30],
    ])
  })

  it('provides the two MMA defaults with 300 s rounds, 60 s rest, and 10 s prep', () => {
    const mma = DEFAULT_PRESETS.filter((p) => p.type === 'MMA')
    expect(mma).toHaveLength(2)
    expect(mma.map((p) => [p.rounds, p.roundSeconds, p.restSeconds, p.prepSeconds])).toEqual([
      [5, 300, 60, 10],
      [3, 300, 60, 10],
    ])
  })
})

describe('v1 -> v2 preset migration', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('preserves every v1 field and assigns BOXING with 5 s prep (requirement 5.10)', () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify([legacyRecord]))

    const loaded = loadPresets()

    expect(loaded).toEqual([
      {
        id: 'legacy-1',
        name: 'My old workout',
        type: 'BOXING',
        rounds: 8,
        roundSeconds: 150,
        restSeconds: 45,
        prepSeconds: DEFAULT_PREP_SECONDS,
        createdAt: 1_700_000_000_000,
      },
    ])

    // The migrated records are written under the v2 key.
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(loaded)
  })

  it('leaves stored records unchanged on every subsequent load (requirement 5.11)', () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify([legacyRecord]))

    const first = loadPresets()
    const afterFirst = window.localStorage.getItem(STORAGE_KEY)

    const second = loadPresets()
    const third = loadPresets()

    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(afterFirst)
  })

  it('does not re-migrate once v2 exists, even when it is an empty list', () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify([legacyRecord]))
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([]))

    expect(loadPresets()).toEqual([])
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual([])
  })

  it('treats a v2 record without a type as BOXING (requirement 5.12)', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ ...legacyRecord, id: 'untyped-1' }, { ...legacyRecord, id: 'bogus-1', type: 'KARATE' }])
    )

    const loaded = loadPresets()

    expect(loaded.map((p) => p.type)).toEqual(['BOXING', 'BOXING'])
    expect(loaded.every((p) => p.prepSeconds === DEFAULT_PREP_SECONDS)).toBe(true)
  })

  it('keeps explicit MMA/CUSTOM types and prep durations intact', () => {
    const typed: Preset[] = [
      { id: 'a', name: 'Champ', type: 'MMA', rounds: 5, roundSeconds: 300, restSeconds: 60, prepSeconds: 10, createdAt: 1 },
      { id: 'b', name: 'Mine', type: 'CUSTOM', rounds: 4, roundSeconds: 90, restSeconds: 0, prepSeconds: 0, createdAt: 2 },
    ]
    savePresets(typed)

    expect(loadPresets()).toEqual(typed)
  })

  it('returns [] and writes nothing when localStorage is unavailable (requirement: catch-and-no-op)', () => {
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage disabled')
    })
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    expect(loadPresets()).toEqual([])
    // A full/unavailable store must not throw out of the save path either.
    expect(() => savePresets(DEFAULT_PRESETS)).not.toThrow()

    getItem.mockRestore()
    setItem.mockRestore()
  })

  it('returns [] when the stored payload is malformed', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json')
    expect(loadPresets()).toEqual([])

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ nope: true }))
    expect(loadPresets()).toEqual([])
  })
})
