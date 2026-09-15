/**
 * The configurable sound engine.
 *
 * Responsibilities, in the order they matter to a user mid-workout:
 *
 * 1. **Always make a sound.** Every role resolves through a fallback chain — assigned
 *    source → its decoded buffer → the role's synthesized tone — so a missing bundled
 *    asset, a purged IndexedDB blob or an offline first paint can never leave a boundary
 *    silent (requirements 3.7, 3.11).
 * 2. **Fire on time.** Boundary sounds and the final-seconds ticks of the active segment
 *    are *pre-scheduled* against the `AudioContext` clock, which is immune to the render
 *    throttling a backgrounded tab suffers (requirement 4.2). Anything whose time has
 *    already passed at reconciliation is discarded rather than played late
 *    (requirements 4.4, 4.5).
 * 3. **Respect the settings.** Volume is the master gain, mute produces no audible output,
 *    and all of it — plus the four role assignments — survives a reload
 *    (requirements 3.6, 3.8, 3.9).
 *
 * Every browser API is reached through an injected factory or a `typeof` guard, so the
 * module imports cleanly on the server and under jsdom, where it degrades to a no-op.
 *
 * Requirements: 3.3, 3.6, 3.7, 3.8, 3.9, 3.11, 4.2, 4.4, 4.5
 */

import { getAudioContext, renderSynth, type SynthContext } from '@/lib/audio'

import {
  clampVolume,
  defaultSoundSettings,
  encodeSoundSource,
  normalizeSoundSettings,
  ROLE_SYNTH,
  SOUND_ROLES,
  synthSourceFor,
  type SoundRole,
  type SoundSettings,
  type SoundSource,
  type SynthId,
} from './types'
import {
  getCustomSoundStore,
  SoundUploadError,
  type CustomSoundMeta,
  type CustomSoundStore,
} from './customStore'

/** Where the settings live, alongside the preset store (requirement 3.6). */
export const SOUND_SETTINGS_STORAGE_KEY = 'boxing_timer_sound_settings_v1'

/** Warning ticks fired in the closing seconds of a round (requirement 4.3). */
export const WARNING_TICK_COUNT = 3

/**
 * The slice of `AudioContext` the engine needs. Declared structurally so a real
 * `AudioContext` and a test double are equally acceptable.
 */
export interface AudioContextLike extends SynthContext {
  readonly currentTime: number
  readonly state: string
  readonly destination: any
  createGain(): any
  createBufferSource(): any
  createBuffer?(numberOfChannels: number, length: number, sampleRate: number): any
  decodeAudioData(data: ArrayBuffer): Promise<any>
  resume?(): any
}

/** The `localStorage` surface the engine uses. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The design's sound-engine contract (plus the extras the UI needs). */
export interface SoundEngine {
  /** Call inside a user gesture: creates/resumes the context and pre-warms buffers. */
  unlock(): void
  /**
   * Plays a role immediately.
   *
   * @param dedupeKey when given, the sound is skipped if a scheduled sound carrying the
   *   same key has already sounded — this is what keeps a pre-scheduled boundary and the
   *   timer engine's transition event from double-firing.
   */
  play(role: SoundRole, dedupeKey?: string): void
  /** Pre-schedules a role on the AudioContext clock. Times already past are discarded. */
  scheduleAt(role: SoundRole, whenCtxTime: number, dedupeKey?: string): void
  /** Cancels everything pre-scheduled, remembering which entries had already sounded. */
  cancelScheduled(): void
  /**
   * Cancels everything pre-scheduled *and* forgets which keys have sounded.
   *
   * Call when a workout starts or stops: the segment keys of the next run repeat those of
   * the last one, and a stale "already sounded" entry would silence them.
   */
  resetPlayback(): void
  /** Replaces and persists the whole settings object. */
  setSettings(settings: SoundSettings): void
  /** Validates, stores and assigns an upload. Resolves to the stored `blobId`. */
  loadCustom(role: SoundRole, file: File): Promise<string>

  /* --- extras used by the settings view and the timer view --- */

  getSettings(): SoundSettings
  setMuted(muted: boolean): void
  setVolume(volume: number): void
  /** Assigns a source to a role (requirement 3.3). */
  assign(role: SoundRole, source: SoundSource): void
  /** Current AudioContext time, or 0 where Web Audio is unavailable. */
  currentTime(): number
  /** Resumes a suspended context (visibility resume; requirement 4.5). */
  resume(): void
  /** Pre-schedules the active segment's boundary sound and warning ticks. */
  scheduleSegment(input: SegmentScheduleInput): void
  /** Lists the stored uploads. */
  listCustom(): Promise<CustomSoundMeta[]>
  /** Deletes an upload and reassigns every role that used it (requirement 3.11). */
  deleteCustom(blobId: string): Promise<void>
  /** Reassigns roles pointing at uploads that no longer exist (requirement 3.11). */
  pruneMissingCustom(): Promise<void>
  /** Subscribes to settings changes. Returns an unsubscribe function. */
  subscribe(listener: (settings: SoundSettings) => void): () => void
}

/** Describes the currently active segment for {@link SoundEngine.scheduleSegment}. */
export interface SegmentScheduleInput {
  /** The active segment's kind — only `round` gets warning ticks (requirement 4.3). */
  kind: 'prep' | 'round' | 'rest'
  /** Milliseconds from now until this segment's end boundary. */
  remainingMs: number
  /** The role to fire at that boundary, or `null` when the boundary is silent. */
  boundaryRole: SoundRole | null
  /** Dedupe key for the boundary sound — normally the next segment's key. */
  boundaryKey?: string
  /** Dedupe key prefix for the warning ticks. */
  tickKeyPrefix?: string
}

/** One entry of a segment's schedule, as an offset from "now". */
export interface ScheduledOffset {
  role: SoundRole
  offsetMs: number
  key?: string
}

/**
 * The pure schedule for one segment: its warning ticks (rounds only) followed by its end
 * boundary. Offsets in the past are dropped here, so the impure scheduler never has to
 * reason about them (requirement 4.4).
 *
 * Kept exported and pure so the timing rules are unit-testable without Web Audio.
 */
export function segmentScheduleOffsets(input: SegmentScheduleInput): ScheduledOffset[] {
  const offsets: ScheduledOffset[] = []
  const remainingMs = Number.isFinite(input.remainingMs) ? input.remainingMs : 0

  if (input.kind === 'round') {
    // Requirement 4.3: one tick per remaining whole second over the final 3 seconds.
    for (let secondsLeft = WARNING_TICK_COUNT; secondsLeft >= 1; secondsLeft -= 1) {
      const offsetMs = remainingMs - secondsLeft * 1000
      if (offsetMs <= 0) continue
      offsets.push({
        role: 'warningTick',
        offsetMs,
        key: input.tickKeyPrefix ? `${input.tickKeyPrefix}#tick-${secondsLeft}` : undefined,
      })
    }
  }

  if (input.boundaryRole && remainingMs > 0) {
    offsets.push({ role: input.boundaryRole, offsetMs: remainingMs, key: input.boundaryKey })
  }

  return offsets
}

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
/* -------------------------------------------------------------------------- */

interface ScheduledEntry {
  key?: string
  whenCtxTime: number
  /** Nodes to stop when the schedule is cancelled. */
  stop: () => void
}

export interface SoundEngineDeps {
  /** Supplies the AudioContext. Returns `null` where Web Audio is unavailable. */
  createContext?: () => AudioContextLike | null
  /** Settings persistence. Defaults to `window.localStorage` when present. */
  storage?: StorageLike | null
  /** Custom upload store. Defaults to the shared IndexedDB-backed store. */
  store?: CustomSoundStore
  /** Fetches a bundled asset's bytes. Defaults to `fetch`. */
  fetchAsset?: (assetPath: string) => Promise<ArrayBuffer>
  /** Synth renderer seam, so tests can assert the fallback chain without oscillators. */
  renderSynthTone?: (
    synthId: SynthId,
    ctx: AudioContextLike,
    destination: any,
    when: number
  ) => void
}

function defaultStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

async function defaultFetchAsset(assetPath: string): Promise<ArrayBuffer> {
  if (typeof fetch !== 'function') throw new Error('fetch is unavailable')
  const response = await fetch(assetPath)
  if (!response.ok) throw new Error(`Asset ${assetPath} responded ${response.status}`)
  return response.arrayBuffer()
}

/**
 * Builds an engine over the supplied dependencies.
 *
 * Nothing touches a browser API during construction: the context is created on first
 * {@link SoundEngine.unlock}/playback and the settings are read from storage eagerly but
 * defensively, so this is safe to call at module scope.
 */
export function createSoundEngine(deps: SoundEngineDeps = {}): SoundEngine {
  const createContext = deps.createContext ?? (() => getAudioContext() as AudioContextLike | null)
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage
  const fetchAsset = deps.fetchAsset ?? defaultFetchAsset
  const renderTone: (
    synthId: SynthId,
    ctx: AudioContextLike,
    destination: any,
    when: number
  ) => void = deps.renderSynthTone ?? renderSynth

  let store: CustomSoundStore | null = deps.store ?? null
  const resolveStore = (): CustomSoundStore => {
    if (!store) store = getCustomSoundStore()
    return store
  }

  let settings: SoundSettings = readSettings()
  let ctx: AudioContextLike | null = null
  let master: any = null

  /** Decoded buffers, keyed by encoded source. `null` marks a permanent failure. */
  const buffers = new Map<string, any | null>()
  const loading = new Set<string>()
  const listeners = new Set<(settings: SoundSettings) => void>()

  let scheduled: ScheduledEntry[] = []
  /** Keys whose sound has already been produced, so it is not produced twice. */
  const sounded = new Set<string>()

  /* ------------------------------ persistence ----------------------------- */

  function readSettings(): SoundSettings {
    if (!storage) return defaultSoundSettings()
    try {
      const raw = storage.getItem(SOUND_SETTINGS_STORAGE_KEY)
      if (raw === null) return defaultSoundSettings()
      return normalizeSoundSettings(JSON.parse(raw))
    } catch {
      return defaultSoundSettings()
    }
  }

  function writeSettings(): void {
    if (!storage) return
    try {
      storage.setItem(SOUND_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // A full or unavailable storage must never break playback.
    }
  }

  function commit(next: SoundSettings): void {
    settings = next
    writeSettings()
    applyGain()
    prewarm()
    for (const listener of listeners) listener(settings)
  }

  /* -------------------------------- context ------------------------------- */

  function ensureContext(): AudioContextLike | null {
    if (ctx) return ctx
    try {
      ctx = createContext()
    } catch {
      ctx = null
    }
    if (!ctx) return null
    try {
      master = ctx.createGain()
      master.gain.value = outputGain()
      master.connect(ctx.destination)
    } catch {
      master = null
    }
    return ctx
  }

  /** The master gain value: the configured volume, or hard zero while muted (req 3.8, 3.9). */
  function outputGain(): number {
    return settings.muted ? 0 : clampVolume(settings.volume)
  }

  function applyGain(): void {
    if (!master) return
    try {
      master.gain.value = outputGain()
    } catch {
      // ignore
    }
  }

  /** The node every sound connects to: the master gain, or the raw destination. */
  function outputNode(active: AudioContextLike): any {
    return master ?? active.destination
  }

  /* ------------------------------- buffers -------------------------------- */

  async function loadBuffer(source: SoundSource): Promise<void> {
    if (source.kind === 'synth') return
    const key = encodeSoundSource(source)
    if (buffers.has(key) || loading.has(key)) return

    const active = ensureContext()
    if (!active) return

    loading.add(key)
    try {
      let bytes: ArrayBuffer
      if (source.kind === 'builtin') {
        bytes = await fetchAsset(source.assetPath)
      } else {
        const record = await resolveStore().get(source.blobId)
        if (!record) throw new Error(`Custom sound ${source.blobId} is gone`)
        bytes = await record.blob.arrayBuffer()
      }
      // `decodeAudioData` detaches its input, so decode a copy.
      const decoded = await active.decodeAudioData(bytes.slice(0))
      buffers.set(key, decoded)
    } catch {
      // Requirement 3.7: a load or decode failure is remembered, and every playback of
      // this source from now on uses the role's synth tone instead.
      buffers.set(key, null)
    } finally {
      loading.delete(key)
    }
  }

  /** Kicks off decoding for every assigned source so the first boundary is not late. */
  function prewarm(): void {
    for (const role of SOUND_ROLES) {
      void loadBuffer(settings.assignments[role])
    }
  }

  /* ------------------------------- playback ------------------------------- */

  /**
   * Emits one sound at `when` on the audio clock, returning a stopper for the nodes it
   * created (or `null` when nothing was created).
   *
   * This is the fallback chain: a decoded buffer is used when it is ready, and every other
   * case — synth assignment, failed load, still-loading buffer, absent buffer source —
   * renders the role's synth tone (requirement 3.7).
   */
  function emit(role: SoundRole, when: number): (() => void) | null {
    const active = ensureContext()
    if (!active) return null

    const source = settings.assignments[role] ?? synthSourceFor(role)
    const destination = outputNode(active)

    if (source.kind !== 'synth') {
      const key = encodeSoundSource(source)
      const buffer = buffers.get(key)
      if (buffer === undefined) {
        // Not decoded yet: start loading for next time and sound the synth now.
        void loadBuffer(source)
      } else if (buffer !== null) {
        try {
          const node = active.createBufferSource()
          node.buffer = buffer
          node.connect(destination)
          node.start(when)
          return () => {
            try {
              node.stop()
            } catch {
              // A node that already ended throws on stop; harmless.
            }
          }
        } catch {
          // Fall through to the synth tone.
        }
      }
    }

    const synthId = source.kind === 'synth' ? source.synthId : ROLE_SYNTH[role]
    renderTone(synthId, active, destination, when)
    // Synth tones are short and self-stopping; there is nothing useful to cancel.
    return null
  }

  /* --------------------------------- API ---------------------------------- */

  const engine: SoundEngine = {
    unlock(): void {
      const active = ensureContext()
      if (!active) return
      try {
        if (active.state === 'suspended') active.resume?.()
      } catch {
        // ignore
      }
      try {
        // A one-sample silent buffer is the canonical iOS unlock gesture.
        if (typeof active.createBuffer === 'function') {
          const buffer = active.createBuffer(1, 1, 22050)
          const node = active.createBufferSource()
          node.buffer = buffer
          node.connect(active.destination)
          node.start(0)
        }
      } catch {
        // ignore
      }
      applyGain()
      prewarm()
    },

    play(role: SoundRole, dedupeKey?: string): void {
      // Requirement 3.9: muted produces no audible output at all.
      if (settings.muted) return
      if (dedupeKey && sounded.has(dedupeKey)) return
      const active = ensureContext()
      if (!active) return
      if (dedupeKey) sounded.add(dedupeKey)
      emit(role, active.currentTime)
    },

    scheduleAt(role: SoundRole, whenCtxTime: number, dedupeKey?: string): void {
      if (settings.muted) return
      if (dedupeKey && sounded.has(dedupeKey)) return
      const active = ensureContext()
      if (!active) return
      // Requirement 4.4: a scheduled time that has already passed is discarded, never
      // played late.
      if (!Number.isFinite(whenCtxTime) || whenCtxTime <= active.currentTime) return

      const stop = emit(role, whenCtxTime)
      scheduled.push({ key: dedupeKey, whenCtxTime, stop: stop ?? (() => {}) })
    },

    cancelScheduled(): void {
      const active = ctx
      const nowCtxTime = active ? active.currentTime : Number.POSITIVE_INFINITY
      for (const entry of scheduled) {
        // Anything whose time has passed on the *audio* clock has already been heard, so
        // remember it: the timer engine's transition event must not repeat it.
        if (entry.key && entry.whenCtxTime <= nowCtxTime) sounded.add(entry.key)
        entry.stop()
      }
      scheduled = []
    },

    resetPlayback(): void {
      for (const entry of scheduled) entry.stop()
      scheduled = []
      sounded.clear()
    },

    scheduleSegment(input: SegmentScheduleInput): void {
      const active = ensureContext()
      if (!active) return
      const base = active.currentTime
      for (const offset of segmentScheduleOffsets(input)) {
        engine.scheduleAt(offset.role, base + offset.offsetMs / 1000, offset.key)
      }
    },

    setSettings(next: SoundSettings): void {
      commit(normalizeSoundSettings(next))
    },

    getSettings(): SoundSettings {
      return settings
    },

    setMuted(muted: boolean): void {
      commit({ ...settings, muted: muted === true })
    },

    setVolume(volume: number): void {
      commit({ ...settings, volume: clampVolume(volume) })
    },

    assign(role: SoundRole, source: SoundSource): void {
      commit({ ...settings, assignments: { ...settings.assignments, [role]: source } })
    },

    currentTime(): number {
      const active = ctx
      return active ? active.currentTime : 0
    },

    resume(): void {
      const active = ctx
      if (!active) return
      try {
        if (active.state === 'suspended') active.resume?.()
      } catch {
        // ignore
      }
    },

    async loadCustom(role: SoundRole, file: File): Promise<string> {
      // A rejection propagates untouched (`SoundUploadError` names the failed gate) and
      // leaves every assignment as it was (requirement 3.5).
      const meta = await resolveStore().add(file)
      engine.assign(role, { kind: 'custom', blobId: meta.blobId })
      return meta.blobId
    },

    listCustom(): Promise<CustomSoundMeta[]> {
      return resolveStore().list()
    },

    async deleteCustom(blobId: string): Promise<void> {
      await resolveStore().remove(blobId)
      buffers.delete(encodeSoundSource({ kind: 'custom', blobId }))

      // Requirement 3.11: every role that referenced the deleted blob returns to its
      // synth tone.
      let changed = false
      const assignments = { ...settings.assignments }
      for (const role of SOUND_ROLES) {
        const source = assignments[role]
        if (source.kind === 'custom' && source.blobId === blobId) {
          assignments[role] = synthSourceFor(role)
          changed = true
        }
      }
      if (changed) commit({ ...settings, assignments })
    },

    async pruneMissingCustom(): Promise<void> {
      const referenced = SOUND_ROLES.map((role) => settings.assignments[role]).filter(
        (source): source is Extract<SoundSource, { kind: 'custom' }> => source.kind === 'custom'
      )
      if (referenced.length === 0) return

      let present: Set<string>
      try {
        present = new Set((await resolveStore().list()).map((meta) => meta.blobId))
      } catch {
        // Unreadable store: leave the assignments alone; playback falls back per 3.7.
        return
      }

      let changed = false
      const assignments = { ...settings.assignments }
      for (const role of SOUND_ROLES) {
        const source = assignments[role]
        if (source.kind === 'custom' && !present.has(source.blobId)) {
          assignments[role] = synthSourceFor(role)
          changed = true
        }
      }
      if (changed) commit({ ...settings, assignments })
    },

    subscribe(listener: (settings: SoundSettings) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  return engine
}

let sharedEngine: SoundEngine | null = null

/** The engine the app uses. Created on first call, so importing this stays SSR-safe. */
export function getSoundEngine(): SoundEngine {
  if (!sharedEngine) sharedEngine = createSoundEngine()
  return sharedEngine
}

/** Test seam: drops the shared engine. */
export function resetSoundEngineForTests(): void {
  sharedEngine = null
}

export { SoundUploadError }
