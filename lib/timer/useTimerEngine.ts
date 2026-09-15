'use client'

/**
 * React binding for the wall-clock timer engine, plus the visibility reconciler.
 *
 * The engine itself is pure (see `plan.ts` and `compute.ts`); this module is the only
 * place that touches React state, wall-clock time, and the DOM. It holds **no countdown
 * state**: every rendered value comes from `snapshot(EngineState, nowMs)` (requirement
 * 1.12), and the driver below exists purely to re-render often enough for the display to
 * look alive (requirement 1.11).
 *
 * Two things drive a reconciliation:
 *
 * 1. a `setInterval` running at {@link DEFAULT_DRIVER_INTERVAL_MS} (250 ms) **while the
 *    document is visible** — stopped while hidden, because a throttled interval in a
 *    background tab contributes nothing to correctness;
 * 2. a `visibilitychange` listener that reconciles *synchronously* on hidden→visible, so
 *    the catch-up latency is bounded well under 250 ms regardless of how long the tab was
 *    backgrounded (requirement 1.5).
 *
 * Because reconciliation is a pure recomputation from the current timestamp, a resume
 * that crossed twenty segment boundaries costs exactly the same as one that crossed none
 * — and emits exactly one transition sound event, for the segment actually landed in,
 * instead of a burst of stale sounds (requirement 2.10).
 *
 * Requirements: 1.5, 1.7, 1.11, 2.10, 2.12
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { effectiveElapsedMs, segmentAt, snapshot } from './compute'
import { buildPlan } from './plan'
import type { EngineState, Segment, TimelinePlan, TimerSnapshot, WorkoutSpec } from './types'

/* -------------------------------------------------------------------------- */
/* Sound events                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The alert a reconciliation asks the sound layer to play.
 *
 * These names line up with the design's `SoundRole`s (`roundStart`, `restStart`,
 * `finished`); `prepStart` is the engine-side event for entering the lead-in segment.
 * The timer view maps them onto `lib/audio.ts` tones (task 4.2) and later onto the
 * configurable `SoundEngine` (task 8.6). Warning ticks are *not* engine events: they are
 * pre-scheduled against the Web Audio clock by the sound layer.
 */
export type TimerSoundRole = 'prepStart' | 'roundStart' | 'restStart' | 'finished'

/** A single transition alert, identifying the segment the reconciliation landed in. */
export interface TimerSoundEvent {
  role: TimerSoundRole
  /** The segment that is active *after* the reconciliation (requirement 2.10). */
  segment: Segment
  /** The wall-clock timestamp of the reconciliation that produced the event. */
  atMs: number
}

/* -------------------------------------------------------------------------- */
/* Pure reconciliation                                                         */
/* -------------------------------------------------------------------------- */

/** Stable identity for a segment within a plan (`prep#0`, `round#3`, `rest#3`, …). */
export function segmentKeyOf(segment: Segment): string {
  return `${segment.kind}#${segment.index}`
}

function roleFor(segment: Segment): TimerSoundRole {
  switch (segment.kind) {
    case 'prep':
      return 'prepStart'
    case 'rest':
      return 'restStart'
    default:
      return 'roundStart'
  }
}

/** The outcome of one reconciliation: what to render, what to play, what to remember. */
export interface ReconcileResult {
  /** The snapshot to render, derived purely from `(state, nowMs)`. */
  snapshot: TimerSnapshot
  /**
   * The transition alerts to emit — **never more than one entry** (requirement 2.10,
   * correctness property P8). A reconciliation that crossed N > 1 boundaries while the
   * tab was hidden still emits a single event, for the landed segment.
   */
  events: TimerSoundEvent[]
  /** The active segment's key, to thread into the next reconciliation as `prevSegmentKey`. */
  segmentKey: string | null
  /** `true` once effective elapsed time has reached `plan.totalMs`. */
  finished: boolean
}

/**
 * Recomputes the timer from a timestamp and reports the sounds that recomputation owes.
 *
 * This is the design's `onVisibilityOrTick` procedure, kept pure so it can be property
 * tested without a DOM: the caller supplies the previously rendered segment key and
 * stores the returned one.
 *
 * - A non-`running` status never advances anything and never emits: `paused`, `idle`, and
 *   `finished` are reported as-is (a paused workout's elapsed time is frozen by
 *   `effectiveElapsedMs`, requirement 1.4).
 * - A landed segment differing from `prevSegmentKey` yields exactly one transition event.
 * - Reaching `plan.totalMs` *replaces* any transition event with the single `finished`
 *   event, so the terminal reconciliation also emits exactly one sound.
 *
 * Postcondition: `events.length <= 1` for every input.
 */
export function reconcile(
  state: EngineState,
  prevSegmentKey: string | null,
  nowMs: number
): ReconcileResult {
  if (state.status !== 'running') {
    return {
      snapshot: snapshot(state, nowMs),
      events: [],
      // An idle engine has nothing active; a paused/finished one keeps its last segment.
      segmentKey: state.status === 'idle' ? null : prevSegmentKey,
      finished: state.status === 'finished',
    }
  }

  const elapsedMs = effectiveElapsedMs(state, nowMs)
  const landed = segmentAt(state.plan, elapsedMs).segment
  const segmentKey = segmentKeyOf(landed)
  const finished = state.plan.totalMs <= 0 || elapsedMs >= state.plan.totalMs

  // At most one event, always: either the landing transition, or the finish, or nothing.
  let events: TimerSoundEvent[] = []
  if (finished) {
    events = [{ role: 'finished', segment: landed, atMs: nowMs }]
  } else if (segmentKey !== prevSegmentKey) {
    events = [{ role: roleFor(landed), segment: landed, atMs: nowMs }]
  }

  return { snapshot: snapshot(state, nowMs), events, segmentKey, finished }
}

/* -------------------------------------------------------------------------- */
/* Reducer                                                                     */
/* -------------------------------------------------------------------------- */

/** Actions accepted by the engine reducer. All timestamps are wall-clock epoch ms. */
export type EngineAction =
  | { type: 'start'; nowMs: number }
  | { type: 'pause'; nowMs: number }
  | { type: 'resume'; nowMs: number }
  | { type: 'stop' }
  | { type: 'finish' }
  | { type: 'setSpec'; spec: WorkoutSpec }

/** The idle state for a spec: anchors cleared, no pause debt. */
export function initEngineState(spec: WorkoutSpec, plan?: TimelinePlan): EngineState {
  return {
    spec,
    plan: plan ?? buildPlan(spec),
    status: 'idle',
    startedAtMs: null,
    pausedAtMs: null,
    accumulatedPauseMs: 0,
  }
}

/**
 * Transitions the wall-clock anchors. Every action is a no-op from a status where it
 * makes no sense, which keeps double-clicks and duplicated events harmless.
 *
 * `resume` is where pause accounting happens: the wall-clock duration of the pause is
 * added to `accumulatedPauseMs`, which `effectiveElapsedMs` subtracts — so a pause shifts
 * the remaining timeline later in wall-clock terms without consuming workout time
 * (requirement 1.7).
 */
export function engineReducer(state: EngineState, action: EngineAction): EngineState {
  switch (action.type) {
    case 'start':
      return {
        ...state,
        status: 'running',
        startedAtMs: action.nowMs,
        pausedAtMs: null,
        accumulatedPauseMs: 0,
      }

    case 'pause':
      if (state.status !== 'running') return state
      return { ...state, status: 'paused', pausedAtMs: action.nowMs }

    case 'resume': {
      if (state.status !== 'paused' || state.pausedAtMs === null) return state
      // Never let a backwards clock create negative pause debt.
      const pausedForMs = Math.max(0, action.nowMs - state.pausedAtMs)
      return {
        ...state,
        status: 'running',
        pausedAtMs: null,
        accumulatedPauseMs: state.accumulatedPauseMs + pausedForMs,
      }
    }

    case 'stop':
      // Requirement 2.12: stopping returns to `idle` with an effective elapsed time of 0.
      return initEngineState(state.spec, state.plan)

    case 'finish':
      if (state.status === 'finished') return state
      // Anchors are retained deliberately: `snapshot` short-circuits on the `finished`
      // status, and session recording (task 10.10) can still inspect when it started.
      return { ...state, status: 'finished', pausedAtMs: null }

    case 'setSpec':
      // Rebuilding the plan mid-workout would invalidate every anchor, so a spec change
      // is only honored while idle (the timer view gates its inputs the same way).
      if (state.status !== 'idle') return state
      return initEngineState(action.spec)

    default:
      return state
  }
}

/* -------------------------------------------------------------------------- */
/* Hook                                                                        */
/* -------------------------------------------------------------------------- */

/** The display refresh cadence while visible; also the reconciliation latency budget. */
export const DEFAULT_DRIVER_INTERVAL_MS = 250

export interface UseTimerEngineOptions {
  /** The workout to run. Applied on change only while the engine is `idle`. */
  spec: WorkoutSpec
  /**
   * Wall-clock source, injectable so tests can drive time deterministically.
   * Defaults to `Date.now`.
   */
  now?: () => number
  /** Called once per emitted transition alert, in emission order. */
  onSoundEvent?: (event: TimerSoundEvent) => void
  /** Driver cadence in milliseconds. Defaults to {@link DEFAULT_DRIVER_INTERVAL_MS}. */
  intervalMs?: number
}

export interface UseTimerEngineResult {
  /** The only source of displayed timing values (requirement 1.12). */
  snapshot: TimerSnapshot
  status: EngineState['status']
  spec: WorkoutSpec
  plan: TimelinePlan
  /** The most recent alert, for consumers that prefer render-time reading to a callback. */
  lastSoundEvent: TimerSoundEvent | null
  /** Starts the workout from zero. Call from a user gesture so audio can be unlocked. */
  start: () => void
  /** Freezes the clock; effective elapsed time stops advancing. */
  pause: () => void
  /** Resumes, charging the elapsed pause to `accumulatedPauseMs`. */
  resume: () => void
  /** Returns to `idle` with elapsed 0 (requirement 2.12). */
  stop: () => void
  /** Alias of {@link UseTimerEngineResult.stop}. */
  reset: () => void
  /** Replaces the workout spec; ignored unless the engine is `idle`. */
  setSpec: (spec: WorkoutSpec) => void
  /** Forces an immediate reconciliation (used by the driver and available to consumers). */
  reconcileNow: () => void
}

const specKeyOf = (spec: WorkoutSpec): string =>
  `${spec.prepSeconds}|${spec.rounds}|${spec.roundSeconds}|${spec.restSeconds}`

const isDocumentVisible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState !== 'hidden'

/**
 * Binds the pure engine to React and keeps it reconciled with wall-clock time.
 *
 * @throws {import('./plan').WorkoutSpecError} when `spec` violates an engine bound
 *   (requirement 2.11). Validate user input before handing it to the hook.
 */
export function useTimerEngine(options: UseTimerEngineOptions): UseTimerEngineResult {
  const { spec, now, onSoundEvent, intervalMs = DEFAULT_DRIVER_INTERVAL_MS } = options

  const [state, dispatch] = useReducer(engineReducer, spec, (s) => initEngineState(s))

  // Latest values, read from interval/event callbacks that must not be re-created per
  // render (a re-created listener would tear down and re-arm the driver constantly).
  const nowRef = useRef<() => number>(now ?? Date.now)
  nowRef.current = now ?? Date.now

  const onSoundEventRef = useRef<UseTimerEngineOptions['onSoundEvent']>(onSoundEvent)
  onSoundEventRef.current = onSoundEvent

  const stateRef = useRef<EngineState>(state)
  stateRef.current = state

  /** The segment rendered by the previous reconciliation; the transition edge detector. */
  const segmentKeyRef = useRef<string | null>(null)

  const [nowMs, setNowMs] = useState<number>(() => nowRef.current())
  const [lastSoundEvent, setLastSoundEvent] = useState<TimerSoundEvent | null>(null)

  const reconcileNow = useCallback((): void => {
    const at = nowRef.current()
    const result = reconcile(stateRef.current, segmentKeyRef.current, at)

    segmentKeyRef.current = result.segmentKey
    setNowMs(at)

    if (result.finished && stateRef.current.status === 'running') {
      dispatch({ type: 'finish' })
    }

    if (result.events.length > 0) {
      const event = result.events[result.events.length - 1]
      setLastSoundEvent(event)
      for (const emitted of result.events) {
        onSoundEventRef.current?.(emitted)
      }
    }
  }, [])

  /**
   * The driver. Reconciles once immediately (so a status change is reflected without
   * waiting a full interval), ticks every `intervalMs` while visible, and reconciles
   * synchronously on hidden→visible.
   *
   * Only a `running` engine needs a driver: idle, paused, and finished snapshots are
   * constant in `nowMs`, so re-rendering them would be pure waste.
   */
  useEffect(() => {
    if (state.status !== 'running') return

    let timer: ReturnType<typeof setInterval> | null = null

    const startTicking = (): void => {
      if (timer === null) timer = setInterval(reconcileNow, intervalMs)
    }
    const stopTicking = (): void => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }

    const onVisibilityChange = (): void => {
      if (isDocumentVisible()) {
        // Catch up first, then resume ticking: the reconciliation happens inside the
        // event handler, so its latency is bounded by the handler itself, not by the
        // interval (requirement 1.5).
        reconcileNow()
        startTicking()
      } else {
        stopTicking()
      }
    }

    reconcileNow()
    if (isDocumentVisible()) startTicking()

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }

    return () => {
      stopTicking()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }
  }, [state.status, state.startedAtMs, state.accumulatedPauseMs, state.plan, intervalMs, reconcileNow])

  // Adopt an externally changed spec while idle (the builder and preset pickers edit it).
  const specKey = specKeyOf(spec)
  useEffect(() => {
    if (stateRef.current.status !== 'idle') return
    if (specKeyOf(stateRef.current.spec) === specKey) return
    dispatch({ type: 'setSpec', spec })
    // `spec` is intentionally read through `specKey`: only value changes matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey])

  const start = useCallback((): void => {
    segmentKeyRef.current = null
    setLastSoundEvent(null)
    dispatch({ type: 'start', nowMs: nowRef.current() })
  }, [])

  const pause = useCallback((): void => {
    dispatch({ type: 'pause', nowMs: nowRef.current() })
  }, [])

  const resume = useCallback((): void => {
    dispatch({ type: 'resume', nowMs: nowRef.current() })
  }, [])

  const stop = useCallback((): void => {
    segmentKeyRef.current = null
    setLastSoundEvent(null)
    dispatch({ type: 'stop' })
  }, [])

  const setSpec = useCallback((next: WorkoutSpec): void => {
    dispatch({ type: 'setSpec', spec: next })
  }, [])

  const currentSnapshot = useMemo(() => snapshot(state, nowMs), [state, nowMs])

  return {
    snapshot: currentSnapshot,
    status: state.status,
    spec: state.spec,
    plan: state.plan,
    lastSoundEvent,
    start,
    pause,
    resume,
    stop,
    reset: stop,
    setSpec,
    reconcileNow,
  }
}
