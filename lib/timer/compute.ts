/**
 * Pure elapsed / segment / snapshot computation for the wall-clock timer engine.
 *
 * Every value the UI shows is derived here from `(EngineState, nowMs)` and nothing else:
 * there is no decremented counter anywhere in the engine. Remaining time is always
 * `segment end boundary − supplied timestamp`, so a backgrounded tab that misses a
 * thousand render ticks still lands on exactly the right phase and countdown the moment
 * it is evaluated again (requirements 1.1, 1.2, 1.6).
 *
 * All three functions are total and side-effect free: same inputs => same output.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.7, 1.9, 1.10, 2.7, 2.8, 2.9
 */

import type { EngineState, Phase, Segment, TimelinePlan, TimerSnapshot } from './types'

/** Restricts `value` to the inclusive range `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/** The active segment plus the time left before its end boundary. */
export interface SegmentLocation {
  segment: Segment
  /** `segment.offsetMs + segment.durationMs − elapsed`, in `[0, segment.durationMs]`. */
  remainingMs: number
}

/**
 * Effective elapsed time since workout start, excluding every paused interval.
 *
 * - Frozen at `pausedAtMs` while the status is `paused`, so the reported value is
 *   independent of `nowMs` (requirements 1.4, 1.7).
 * - `accumulatedPauseMs` — the wall-clock time already spent paused — is subtracted, so
 *   a pause shifts the whole remaining timeline later in wall-clock terms without
 *   consuming workout time (requirement 1.7).
 * - Clamped to `[0, plan.totalMs]`, which covers both a timestamp earlier than the start
 *   (requirement 1.9) and a resume long after the workout should have ended
 *   (requirement 1.10).
 *
 * Postconditions: the result is in `[0, plan.totalMs]`, is non-decreasing in `nowMs`
 * while `running`, and is constant in `nowMs` while `paused`.
 */
export function effectiveElapsedMs(state: EngineState, nowMs: number): number {
  if (state.startedAtMs === null) return 0

  // While paused the clock stops at the instant of the pause; every later timestamp
  // reports the same elapsed value.
  const rawEnd = state.status === 'paused' && state.pausedAtMs !== null ? state.pausedAtMs : nowMs

  const elapsed = rawEnd - state.startedAtMs - state.accumulatedPauseMs

  return clamp(elapsed, 0, state.plan.totalMs)
}

/**
 * Locates the active segment for an elapsed offset into the workout.
 *
 * Boundary rule (requirements 2.8, 2.9): the comparison is `elapsed < segmentEnd`, so an
 * elapsed value landing exactly on a segment's end boundary belongs to the *following*
 * segment — never to the one that just finished. At `plan.totalMs` there is no following
 * segment, so the final segment stays active with `remainingMs === 0`.
 *
 * Preconditions: `plan.segments` is non-empty and contiguous (as produced by `buildPlan`).
 * Postconditions: `segment.offsetMs <= clamp(elapsedMs) <= segment.offsetMs + segment.durationMs`
 * and `remainingMs ∈ [0, segment.durationMs]`.
 */
export function segmentAt(plan: TimelinePlan, elapsedMs: number): SegmentLocation {
  const segments = plan.segments

  if (segments.length === 0) {
    throw new Error('segmentAt requires a plan with at least one segment')
  }

  const capped = clamp(elapsedMs, 0, plan.totalMs)

  for (const segment of segments) {
    const endMs = segment.offsetMs + segment.durationMs

    // Strict `<` is what makes an exact boundary fall through to the next segment.
    if (capped < endMs) {
      return { segment, remainingMs: endMs - capped }
    }
  }

  // Only reachable at `capped === plan.totalMs`: the workout is over, so the final
  // segment remains the active one with nothing left on its clock.
  const tail = segments[segments.length - 1]
  return { segment: tail, remainingMs: 0 }
}

/** The 1-based round number a segment belongs to (`prep` sits before round 1). */
function roundNumberOf(segment: Segment): number {
  return segment.kind === 'prep' ? 1 : segment.index
}

/** Percentage of the current phase already consumed, clamped to `[0, 100]`. */
function progressOf(phaseTotalMs: number, remainingMs: number): number {
  if (phaseTotalMs <= 0) return 100
  return clamp(((phaseTotalMs - remainingMs) / phaseTotalMs) * 100, 0, 100)
}

/**
 * Derives the complete render-ready snapshot from `(state, nowMs)`.
 *
 * Ordering of the cases matters:
 *
 * 1. an explicitly `finished` status reports the terminal snapshot even after its
 *    wall-clock anchors have been cleared;
 * 2. `idle` (or an absent start anchor) reports the workout's first segment at full
 *    duration with zero elapsed (requirement 2.12);
 * 3. an effective elapsed time that has reached `plan.totalMs` reports phase `finished`,
 *    which is what turns "resumed the tab an hour late" into a finished workout rather
 *    than an out-of-range read (requirements 1.10, 2.9);
 * 4. otherwise the active segment's kind is the phase — except while `paused`, which is a
 *    phase of its own (requirement 1.8).
 *
 * Postconditions: `remainingMs >= 0`, `progressPct ∈ [0, 100]`, and
 * `elapsedWorkoutMs ∈ [0, plan.totalMs]` for every input (requirements 1.9, 1.10).
 */
export function snapshot(state: EngineState, nowMs: number): TimerSnapshot {
  const { plan, spec } = state
  const totalRounds = spec.rounds
  const segments = plan.segments
  const lastSegment = segments.length > 0 ? segments[segments.length - 1] : null

  const finishedSnapshot = (): TimerSnapshot => ({
    phase: 'finished',
    currentRound: totalRounds,
    totalRounds,
    remainingMs: 0,
    phaseTotalMs: lastSegment?.durationMs ?? 0,
    progressPct: 100,
    elapsedWorkoutMs: plan.totalMs,
    finished: true,
  })

  if (state.status === 'finished') {
    return finishedSnapshot()
  }

  const elapsedWorkoutMs = effectiveElapsedMs(state, nowMs)

  if (state.status === 'idle' || state.startedAtMs === null) {
    const first = segments[0]
    return {
      phase: 'idle',
      currentRound: first ? roundNumberOf(first) : 1,
      totalRounds,
      remainingMs: first?.durationMs ?? 0,
      phaseTotalMs: first?.durationMs ?? 0,
      progressPct: 0,
      elapsedWorkoutMs: 0,
      finished: false,
    }
  }

  if (plan.totalMs <= 0 || elapsedWorkoutMs >= plan.totalMs) {
    return finishedSnapshot()
  }

  const { segment, remainingMs } = segmentAt(plan, elapsedWorkoutMs)
  const phase: Phase = state.status === 'paused' ? 'paused' : segment.kind

  return {
    phase,
    currentRound: roundNumberOf(segment),
    totalRounds,
    remainingMs: Math.max(0, remainingMs),
    phaseTotalMs: segment.durationMs,
    progressPct: progressOf(segment.durationMs, remainingMs),
    elapsedWorkoutMs,
    finished: false,
  }
}
