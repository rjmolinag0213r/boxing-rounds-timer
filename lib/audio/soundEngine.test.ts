/**
 * Unit tests for the sound engine (task 8.7).
 *
 * Four behaviours matter more than any others, because each one is the difference between
 * "the bell rang" and "the workout was silent":
 *
 * - the **fallback chain** — an assigned source that will not load or decode must still
 *   produce the role's synth tone (requirement 3.7);
 * - **mute and volume** — mute produces nothing audible, volume lands on the output gain
 *   (requirements 3.8, 3.9);
 * - **restoration** — a reload rebuilds mute, volume and all four assignments from storage
 *   (requirement 3.6);
 * - **deleted uploads** — a role pointing at a deleted blob returns to its synth tone
 *   (requirement 3.11).
 *
 * Web Audio, `localStorage` and the upload store are all injected, so nothing here needs a
 * real AudioContext (jsdom has none).
 *
 * **Validates: Requirements 3.6, 3.7, 3.8, 3.9, 3.11, 4.4**
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  createSoundEngine,
  segmentScheduleOffsets,
  SOUND_SETTINGS_STORAGE_KEY,
  type AudioContextLike,
  type SoundEngine,
  type SoundEngineDeps,
  type StorageLike,
} from './soundEngine'
import { SoundUploadError, type CustomSoundMeta, type CustomSoundStore } from './customStore'
import { defaultSoundSettings, type SoundSettings, type SynthId } from './types'

/* -------------------------------------------------------------------------- */
/* Doubles                                                                     */
/* -------------------------------------------------------------------------- */

/** The synth renderer seam, spied on to observe the fallback chain. */
type ToneRenderer = NonNullable<SoundEngineDeps['renderSynthTone']>

interface FakeGain {
  gain: { value: number; setValueAtTime: () => void; exponentialRampToValueAtTime: () => void }
  connect: () => void
}

interface FakeBufferSource {
  buffer: unknown
  startedAt: number | null
  stopped: boolean
  connect: () => void
  start: (when?: number) => void
  stop: () => void
}

interface FakeContext extends AudioContextLike {
  gains: FakeGain[]
  sources: FakeBufferSource[]
  setCurrentTime: (seconds: number) => void
  resumeCalls: number
}

function createFakeContext(options: { decode?: () => Promise<unknown>; state?: string } = {}) {
  const gains: FakeGain[] = []
  const sources: FakeBufferSource[] = []
  let currentTime = 0
  let resumeCalls = 0

  const ctx = {
    get currentTime() {
      return currentTime
    },
    state: options.state ?? 'running',
    destination: { id: 'destination' },
    gains,
    sources,
    resumeCalls: 0,
    setCurrentTime(seconds: number) {
      currentTime = seconds
    },
    createGain(): FakeGain {
      const node: FakeGain = {
        gain: { value: 1, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
      }
      gains.push(node)
      return node
    },
    createBufferSource(): FakeBufferSource {
      const node: FakeBufferSource = {
        buffer: null,
        startedAt: null,
        stopped: false,
        connect: () => {},
        start(when = 0) {
          node.startedAt = when
        },
        stop() {
          node.stopped = true
        },
      }
      sources.push(node)
      return node
    },
    createBuffer: () => ({ length: 1 }),
    createOscillator: () => ({
      type: 'sine',
      frequency: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} },
      connect: () => {},
      start: () => {},
      stop: () => {},
    }),
    decodeAudioData: options.decode ?? (async () => ({ duration: 1.5 })),
    resume() {
      resumeCalls += 1
      ctx.resumeCalls = resumeCalls
    },
  }

  return ctx as unknown as FakeContext
}

function createFakeStorage(seed?: Record<string, string>): StorageLike & { dump: () => string | null } {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    dump: () => map.get(SOUND_SETTINGS_STORAGE_KEY) ?? null,
  }
}

/** An in-memory {@link CustomSoundStore} whose blobs decode successfully. */
function createFakeStore(initial: CustomSoundMeta[] = []) {
  const metas = new Map(initial.map((meta) => [meta.blobId, meta]))
  const store: CustomSoundStore = {
    isDurable: () => true,
    async add(file) {
      const meta: CustomSoundMeta = {
        blobId: `blob-${metas.size + 1}`,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        durationSeconds: 1,
        createdAt: metas.size,
      }
      metas.set(meta.blobId, meta)
      return meta
    },
    async list() {
      return [...metas.values()]
    },
    async get(blobId) {
      const meta = metas.get(blobId)
      if (!meta) return null
      return {
        ...meta,
        blob: { arrayBuffer: async () => new ArrayBuffer(16) } as unknown as Blob,
      }
    },
    async remove(blobId) {
      metas.delete(blobId)
    },
  }
  return { store, metas }
}

/** Lets every pending microtask/timer callback settle (buffer loads are async). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const BUILTIN: SoundSettings['assignments']['roundStart'] = {
  kind: 'builtin',
  assetPath: '/sounds/boxing-bell.mp3',
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('sound engine fallback chain', () => {
  let ctx: FakeContext
  let renderSynthTone: Mock<ToneRenderer>

  const build = (overrides: Parameters<typeof createSoundEngine>[0] = {}): SoundEngine =>
    createSoundEngine({
      createContext: () => ctx,
      storage: createFakeStorage(),
      renderSynthTone,
      ...overrides,
    })

  /** The synth ids the renderer was asked for. */
  const rendered = (): SynthId[] => renderSynthTone.mock.calls.map((call) => call[0])

  beforeEach(() => {
    ctx = createFakeContext()
    renderSynthTone = vi.fn()
  })

  it('plays the role synth tone for a synth assignment', async () => {
    // Requirement 3.7 (default assignment is the role's synth tone).
    const engine = build()
    engine.play('roundStart')
    engine.play('restStart')
    engine.play('warningTick')
    engine.play('finished')

    expect(rendered()).toEqual(['bell', 'buzzer', 'tick', 'airhorn'])
    expect(ctx.sources).toHaveLength(0)
  })

  it('plays a decoded buffer when the assigned asset loads', async () => {
    const engine = build({ fetchAsset: async () => new ArrayBuffer(32) })
    engine.assign('roundStart', BUILTIN)
    await settle()

    renderSynthTone.mockClear()
    engine.play('roundStart')

    expect(ctx.sources).toHaveLength(1)
    expect(ctx.sources[0].buffer).toEqual({ duration: 1.5 })
    // No synth tone: the assigned source succeeded.
    expect(rendered()).toEqual([])
  })

  it('falls back to the role synth tone when the assigned asset fails to load', async () => {
    // Requirement 3.7: a missing bundled asset (404) must not silence the boundary.
    const fetchAsset = vi.fn(async () => {
      throw new Error('404')
    })
    const engine = build({ fetchAsset })
    engine.assign('roundStart', BUILTIN)
    await settle()

    renderSynthTone.mockClear()
    engine.play('roundStart')

    expect(fetchAsset).toHaveBeenCalled()
    expect(ctx.sources).toHaveLength(0)
    expect(rendered()).toEqual(['bell'])
  })

  it('falls back to the role synth tone when the assigned asset fails to decode', async () => {
    // Requirement 3.7.
    ctx = createFakeContext({
      decode: async () => {
        throw new Error('EncodingError')
      },
    })
    const engine = build({ fetchAsset: async () => new ArrayBuffer(32) })
    engine.assign('finished', BUILTIN)
    await settle()

    renderSynthTone.mockClear()
    engine.play('finished')

    expect(ctx.sources).toHaveLength(0)
    expect(rendered()).toEqual(['airhorn'])
  })

  it('falls back to the role synth tone when the assigned upload is gone from the store', async () => {
    // Requirements 3.7, 3.11: the assignment survived a cleared IndexedDB.
    const { store } = createFakeStore()
    const engine = build({ store })
    engine.assign('restStart', { kind: 'custom', blobId: 'missing' })
    await settle()

    renderSynthTone.mockClear()
    engine.play('restStart')

    expect(ctx.sources).toHaveLength(0)
    expect(rendered()).toEqual(['buzzer'])
  })

  it('plays a stored upload once it is decoded', async () => {
    const { store } = createFakeStore([
      {
        blobId: 'blob-1',
        name: 'my-bell.wav',
        mimeType: 'audio/wav',
        sizeBytes: 2048,
        durationSeconds: 1.2,
        createdAt: 1,
      },
    ])
    const engine = build({ store })
    engine.assign('roundStart', { kind: 'custom', blobId: 'blob-1' })
    await settle()

    renderSynthTone.mockClear()
    engine.play('roundStart')

    expect(ctx.sources).toHaveLength(1)
    expect(rendered()).toEqual([])
  })
})

describe('sound engine mute and volume', () => {
  let ctx: FakeContext
  let renderSynthTone: Mock<ToneRenderer>

  const build = (): SoundEngine =>
    createSoundEngine({
      createContext: () => ctx,
      storage: createFakeStorage(),
      renderSynthTone,
    })

  beforeEach(() => {
    ctx = createFakeContext()
    renderSynthTone = vi.fn()
  })

  it('applies the configured volume as the output gain', () => {
    // Requirement 3.8.
    const engine = build()
    engine.setVolume(0.25)
    engine.play('roundStart')

    // The master gain is the first gain node the engine creates.
    expect(ctx.gains[0].gain.value).toBeCloseTo(0.25)
  })

  it('clamps the volume into [0, 1]', () => {
    // Requirement 3.8.
    const engine = build()

    engine.setVolume(4)
    expect(engine.getSettings().volume).toBe(1)

    engine.setVolume(-2)
    expect(engine.getSettings().volume).toBe(0)
  })

  it('produces no audible output for any role while muted', () => {
    // Requirement 3.9.
    const engine = build()
    engine.setMuted(true)

    engine.play('roundStart')
    engine.play('restStart')
    engine.play('warningTick')
    engine.play('finished')
    engine.scheduleAt('roundStart', engine.currentTime() + 10)

    expect(renderSynthTone).not.toHaveBeenCalled()
    expect(ctx.sources).toHaveLength(0)
  })

  it('drives the output gain to zero while muted and back on unmute', () => {
    // Requirement 3.9: anything already scheduled is silenced too.
    const engine = build()
    engine.setVolume(0.6)
    engine.play('roundStart')
    const master = ctx.gains[0]

    engine.setMuted(true)
    expect(master.gain.value).toBe(0)

    engine.setMuted(false)
    expect(master.gain.value).toBeCloseTo(0.6)
  })
})

describe('sound engine settings persistence', () => {
  it('restores muted state, volume and all four assignments after a reload', async () => {
    // Requirement 3.6.
    const storage = createFakeStorage()
    const ctx = createFakeContext()
    const { store } = createFakeStore()

    const first = createSoundEngine({
      createContext: () => ctx,
      storage,
      store,
      renderSynthTone: vi.fn(),
    })
    first.setVolume(0.35)
    first.setMuted(true)
    first.assign('roundStart', BUILTIN)
    first.assign('warningTick', { kind: 'synth', synthId: 'beep' })
    first.assign('finished', { kind: 'custom', blobId: 'blob-9' })

    expect(storage.dump()).not.toBeNull()

    // A reload: a brand new engine over the same storage.
    const reloaded = createSoundEngine({
      createContext: () => createFakeContext(),
      storage,
      store,
      renderSynthTone: vi.fn(),
    })

    expect(reloaded.getSettings()).toEqual({
      muted: true,
      volume: 0.35,
      assignments: {
        roundStart: BUILTIN,
        restStart: { kind: 'synth', synthId: 'buzzer' },
        warningTick: { kind: 'synth', synthId: 'beep' },
        finished: { kind: 'custom', blobId: 'blob-9' },
      },
    })
  })

  it('falls back to the defaults when the stored settings are corrupt', () => {
    // Requirement 3.6: a bad record must not brick playback.
    const storage = createFakeStorage({ [SOUND_SETTINGS_STORAGE_KEY]: '{not json' })
    const engine = createSoundEngine({
      createContext: () => createFakeContext(),
      storage,
      renderSynthTone: vi.fn(),
    })

    expect(engine.getSettings()).toEqual(defaultSoundSettings())
  })

  it('repairs a partially stored record field by field', () => {
    const storage = createFakeStorage({
      [SOUND_SETTINGS_STORAGE_KEY]: JSON.stringify({
        volume: 12,
        assignments: { roundStart: { kind: 'synth', synthId: 'nope' } },
      }),
    })
    const engine = createSoundEngine({
      createContext: () => createFakeContext(),
      storage,
      renderSynthTone: vi.fn(),
    })

    const settings = engine.getSettings()
    expect(settings.muted).toBe(false)
    expect(settings.volume).toBe(1)
    // An unknown synth id degrades to the role's own tone.
    expect(settings.assignments.roundStart).toEqual({ kind: 'synth', synthId: 'bell' })
    expect(settings.assignments.finished).toEqual({ kind: 'synth', synthId: 'airhorn' })
  })
})

describe('sound engine custom upload lifecycle', () => {
  let ctx: FakeContext
  let renderSynthTone: Mock<ToneRenderer>

  beforeEach(() => {
    ctx = createFakeContext()
    renderSynthTone = vi.fn()
  })

  const meta = (blobId: string): CustomSoundMeta => ({
    blobId,
    name: `${blobId}.wav`,
    mimeType: 'audio/wav',
    sizeBytes: 1024,
    durationSeconds: 1,
    createdAt: 1,
  })

  it('reassigns every role referencing a deleted blob back to its synth tone', async () => {
    // Requirement 3.11.
    const { store, metas } = createFakeStore([meta('blob-1')])
    const engine = createSoundEngine({
      createContext: () => ctx,
      storage: createFakeStorage(),
      store,
      renderSynthTone,
    })

    const custom = { kind: 'custom' as const, blobId: 'blob-1' }
    engine.assign('roundStart', custom)
    engine.assign('finished', custom)
    engine.assign('restStart', { kind: 'synth', synthId: 'beep' })

    await engine.deleteCustom('blob-1')

    expect(metas.has('blob-1')).toBe(false)
    expect(engine.getSettings().assignments).toEqual({
      roundStart: { kind: 'synth', synthId: 'bell' },
      restStart: { kind: 'synth', synthId: 'beep' }, // untouched: it never used the blob
      warningTick: { kind: 'synth', synthId: 'tick' },
      finished: { kind: 'synth', synthId: 'airhorn' },
    })

    // ...and the reassignment is what plays from now on.
    renderSynthTone.mockClear()
    engine.play('roundStart')
    expect(renderSynthTone.mock.calls.map((call) => call[0])).toEqual(['bell'])
  })

  it('prunes assignments whose upload is no longer in the store', async () => {
    // Requirement 3.11: the blob was deleted on another visit / by a storage purge.
    const { store } = createFakeStore([meta('blob-keep')])
    const engine = createSoundEngine({
      createContext: () => ctx,
      storage: createFakeStorage(),
      store,
      renderSynthTone,
    })

    engine.assign('roundStart', { kind: 'custom', blobId: 'blob-gone' })
    engine.assign('finished', { kind: 'custom', blobId: 'blob-keep' })

    await engine.pruneMissingCustom()

    expect(engine.getSettings().assignments.roundStart).toEqual({ kind: 'synth', synthId: 'bell' })
    expect(engine.getSettings().assignments.finished).toEqual({
      kind: 'custom',
      blobId: 'blob-keep',
    })
  })

  it('assigns a validated upload to the requested role', async () => {
    const { store } = createFakeStore()
    const engine = createSoundEngine({
      createContext: () => ctx,
      storage: createFakeStorage(),
      store,
      renderSynthTone,
    })

    const file = { name: 'horn.wav', type: 'audio/wav', size: 2048 } as unknown as File
    const blobId = await engine.loadCustom('finished', file)

    expect(engine.getSettings().assignments.finished).toEqual({ kind: 'custom', blobId })
  })

  it('keeps every assignment when an upload is rejected', async () => {
    // Requirement 3.5: a rejected upload changes nothing.
    const { store } = createFakeStore()
    store.add = async () => {
      throw new SoundUploadError('size', 'too big')
    }
    const engine = createSoundEngine({
      createContext: () => ctx,
      storage: createFakeStorage(),
      store,
      renderSynthTone,
    })
    const before = engine.getSettings().assignments

    await expect(
      engine.loadCustom('roundStart', { name: 'x.wav', type: 'audio/wav', size: 1 } as unknown as File)
    ).rejects.toMatchObject({ reason: 'size' })

    expect(engine.getSettings().assignments).toEqual(before)
  })
})

describe('sound engine scheduling discipline', () => {
  let ctx: FakeContext
  let renderSynthTone: Mock<ToneRenderer>

  const build = (): SoundEngine =>
    createSoundEngine({
      createContext: () => ctx,
      storage: createFakeStorage(),
      renderSynthTone,
    })

  beforeEach(() => {
    ctx = createFakeContext()
    renderSynthTone = vi.fn()
  })

  it('schedules a future sound against the AudioContext clock', () => {
    // Requirement 4.2.
    const engine = build()
    ctx.setCurrentTime(10)
    engine.scheduleAt('roundStart', 13.5)

    expect(renderSynthTone).toHaveBeenCalledTimes(1)
    expect(renderSynthTone.mock.calls[0][3]).toBeCloseTo(13.5)
  })

  it('discards a scheduled sound whose time has already passed', () => {
    // Requirement 4.4.
    const engine = build()
    ctx.setCurrentTime(10)

    engine.scheduleAt('roundStart', 9.9)
    engine.scheduleAt('roundStart', 10)

    expect(renderSynthTone).not.toHaveBeenCalled()
  })

  it('does not repeat a boundary that already sounded off the audio clock', () => {
    // Requirements 4.2, 4.4: the pre-scheduled buzzer and the timer engine's transition
    // event describe the same boundary, so only one of them may be heard.
    const engine = build()
    engine.scheduleAt('restStart', 5, 'rest#1')
    renderSynthTone.mockClear()

    ctx.setCurrentTime(6) // the scheduled time has passed: it was heard
    engine.cancelScheduled()
    engine.play('restStart', 'rest#1')

    expect(renderSynthTone).not.toHaveBeenCalled()

    // A new workout reuses the same keys, so the record is cleared on reset.
    engine.resetPlayback()
    engine.play('restStart', 'rest#1')
    expect(renderSynthTone).toHaveBeenCalledTimes(1)
  })

  it('still sounds a boundary whose scheduled time never arrived on a suspended clock', () => {
    // The iOS case: the context was suspended while backgrounded, so `currentTime` never
    // reached the scheduled instant and nothing was heard. The reconciliation's event must
    // therefore play (requirement 4.5).
    const engine = build()
    engine.scheduleAt('restStart', 120, 'rest#1')
    renderSynthTone.mockClear()

    engine.cancelScheduled() // currentTime is still 0
    engine.play('restStart', 'rest#1')

    expect(renderSynthTone).toHaveBeenCalledTimes(1)
  })

  it('stops the nodes it cancels', async () => {
    const engine = createSoundEngine({
      createContext: () => ctx,
      storage: createFakeStorage(),
      fetchAsset: async () => new ArrayBuffer(8),
    })
    engine.assign('roundStart', BUILTIN)
    await settle()

    engine.scheduleAt('roundStart', 30, 'round#2')
    expect(ctx.sources).toHaveLength(1)

    engine.cancelScheduled()
    expect(ctx.sources[0].stopped).toBe(true)
  })

  it('resumes a suspended context', () => {
    ctx = createFakeContext({ state: 'suspended' })
    const engine = build()
    engine.unlock()

    expect(ctx.resumeCalls).toBeGreaterThan(0)
  })

  it('is a harmless no-op where Web Audio does not exist', () => {
    const engine = createSoundEngine({
      createContext: () => null,
      storage: createFakeStorage(),
      renderSynthTone,
    })

    expect(() => {
      engine.unlock()
      engine.play('roundStart')
      engine.scheduleAt('roundStart', 5)
      engine.scheduleSegment({ kind: 'round', remainingMs: 10_000, boundaryRole: 'restStart' })
      engine.cancelScheduled()
      engine.resetPlayback()
      engine.resume()
    }).not.toThrow()
    expect(engine.currentTime()).toBe(0)
  })

  it('pre-schedules a round as three warning ticks followed by its boundary', () => {
    // Requirements 4.2, 4.3.
    const offsets = segmentScheduleOffsets({
      kind: 'round',
      remainingMs: 180_000,
      boundaryRole: 'restStart',
      boundaryKey: 'rest#1',
      tickKeyPrefix: 'round#1',
    })

    expect(offsets).toEqual([
      { role: 'warningTick', offsetMs: 177_000, key: 'round#1#tick-3' },
      { role: 'warningTick', offsetMs: 178_000, key: 'round#1#tick-2' },
      { role: 'warningTick', offsetMs: 179_000, key: 'round#1#tick-1' },
      { role: 'restStart', offsetMs: 180_000, key: 'rest#1' },
    ])
  })

  it('drops warning ticks whose second has already elapsed', () => {
    // Requirement 4.4: a resume 1.5 s from the end schedules only the tick still ahead.
    const offsets = segmentScheduleOffsets({
      kind: 'round',
      remainingMs: 1_500,
      boundaryRole: 'finished',
    })

    expect(offsets).toEqual([
      { role: 'warningTick', offsetMs: 500, key: undefined },
      { role: 'finished', offsetMs: 1_500, key: undefined },
    ])
  })

  it('gives prep and rest segments a boundary sound but no warning ticks', () => {
    // Requirement 4.3 scopes the ticks to rounds.
    for (const kind of ['prep', 'rest'] as const) {
      expect(
        segmentScheduleOffsets({ kind, remainingMs: 60_000, boundaryRole: 'roundStart' })
      ).toEqual([{ role: 'roundStart', offsetMs: 60_000, key: undefined }])
    }
  })

  it('schedules nothing for a segment with no remaining time', () => {
    expect(
      segmentScheduleOffsets({ kind: 'round', remainingMs: 0, boundaryRole: 'restStart' })
    ).toEqual([])
  })

  it('turns a segment schedule into AudioContext times', () => {
    const engine = build()
    ctx.setCurrentTime(100)

    engine.scheduleSegment({
      kind: 'round',
      remainingMs: 5_000,
      boundaryRole: 'restStart',
      boundaryKey: 'rest#1',
      tickKeyPrefix: 'round#1',
    })

    const times = renderSynthTone.mock.calls.map((call) => Number(call[3]))
    expect(times).toEqual([102, 103, 104, 105])
  })
})
