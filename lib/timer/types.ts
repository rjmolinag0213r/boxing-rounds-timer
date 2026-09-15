/**
 * Timer domain types for the wall-clock timer engine.
 *
 * The engine never stores a decremented countdown. A running workout is fully
 * described by an immutable {@link TimelinePlan} plus wall-clock anchors on
 * {@link EngineState}; every displayed value is derived as a {@link TimerSnapshot}
 * from `(EngineState, nowMs)`. This is what makes the timer immune to iOS Safari
 * throttling or suspending timers for backgrounded tabs.
 *
 * Requirements: 1.8, 2.1
 */

/** The user-visible state of the timer. */
export type Phase = 'idle' | 'prep' | 'round' | 'rest' | 'paused' | 'finished'

/** A user-authored workout format, in seconds. */
export interface WorkoutSpec {
  /** Lead-in countdown before round 1; >= 0 (0 => no prep segment). Default 5. */
  prepSeconds: number
  /** Number of rounds; >= 1. */
  rounds: number
  /** Duration of each round; >= 1. */
  roundSeconds: number
  /** Duration of each rest; >= 0 (0 => rest phases skipped). */
  restSeconds: number
}

/** A single contiguous timed segment within a workout. */
export interface Segment {
  kind: 'prep' | 'round' | 'rest'
  /** 1-based round number for `round`/`rest`; 0 for `prep`. */
  index: number
  /** Segment length in milliseconds; > 0. */
  durationMs: number
  /** Cumulative start offset from workout start, in milliseconds. */
  offsetMs: number
}

/** Immutable plan derived once from a {@link WorkoutSpec}. */
export interface TimelinePlan {
  /** Ordered and contiguous; the sum of all durations equals {@link TimelinePlan.totalMs}. */
  segments: Segment[]
  /** Total workout duration in milliseconds. */
  totalMs: number
}

/**
 * The live, serializable engine state.
 *
 * `paused` is a status distinct from `idle`, `running`, and `finished`
 * (requirement 1.8), so a paused workout retains its anchors while its
 * effective elapsed time stays frozen at {@link EngineState.pausedAtMs}.
 */
export interface EngineState {
  spec: WorkoutSpec
  plan: TimelinePlan
  status: 'idle' | 'running' | 'paused' | 'finished'
  /** When the *workout* (prep) started, in wall-clock epoch ms. `null` when idle/finished. */
  startedAtMs: number | null
  /** When the workout was paused, in wall-clock epoch ms. `null` unless paused. */
  pausedAtMs: number | null
  /** Total wall-clock time spent paused so far, in milliseconds; >= 0. */
  accumulatedPauseMs: number
}

/** A derived, render-friendly snapshot computed from {@link EngineState} + `nowMs`. */
export interface TimerSnapshot {
  phase: Phase
  /** 1-based round number. */
  currentRound: number
  totalRounds: number
  /** Remaining time in the current phase, in milliseconds; >= 0. */
  remainingMs: number
  /** Duration of the current phase, in milliseconds. */
  phaseTotalMs: number
  /** Progress within the current phase, in the range `[0, 100]`. */
  progressPct: number
  /** Total elapsed time excluding pauses, clamped to `plan.totalMs`. */
  elapsedWorkoutMs: number
  finished: boolean
}
