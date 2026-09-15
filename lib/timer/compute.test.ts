import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { effectiveElapsedMs, segmentAt, snapshot } from '@/lib/timer/compute'
import { buildPlan } from '@/lib/timer/plan'
import type { EngineState, Segment, TimelinePlan, WorkoutSpec } from '@/lib/timer/types'

/* -------------------------------------------------------------------------- */
/* Generators                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Arbitrary *valid* `WorkoutSpec` within the authoring bounds (rounds 1–99,
 * round 1–3600 s, rest 0–600 s, prep 0–60 s). `restSeconds` and `prepSeconds` hit 0
 * often enough to exercise the "no rest" and "no prep" plan shapes.
 */
const anySpec = (): fc.Arbitrary<WorkoutSpec> =>
  fc.record({
    rounds: fc.integer({ min: 1, max: 99 }),
    roundSeconds: fc.integer({ min: 1, max: 3600 }),
    restSeconds: fc.oneof(
      { arbitrary: fc.constant(0), weight: 1 },
      { arbitrary: fc.integer({ min: 1, max: 600 }), weight: 3 }
    ),
    prepSeconds: fc.oneof(
      { arbitrary: fc.constant(0), weight: 1 },
      { arbitrary: fc.integer({ min: 1, max: 60 }), weight: 3 }
    ),
  })

/**
 * A *short* spec, used where a test walks the whole workout millisecond-budget: total
 * duration stays under ~40 s so exhaustive walks remain cheap.
 */
const shortSpec = (): fc.Arbitrary<WorkoutSpec> =>
  fc.record({
    rounds: fc.integer({ min: 1, max: 5 }),
    roundSeconds: fc.integer({ min: 1, max: 4 }),
    restSeconds: fc.oneof(
      { arbitrary: fc.constant(0), weight: 1 },
      { arbitrary: fc.integer({ min: 1, max: 3 }), weight: 3 }
    ),
    prepSeconds: fc.oneof(
      { arbitrary: fc.constant(0), weight: 1 },
      { arbitrary: fc.integer({ min: 1, max: 3 }), weight: 3 }
    ),
  })

/** Plausible wall-clock epoch milliseconds (2001-09-09 … 2027-01-01). */
const anyEpochMs = (): fc.Arbitrary<number> => fc.integer({ min: 1_000_000_000_000, max: 1_800_000_000_000 })

/** Wall-clock time already spent paused, in milliseconds. */
const anyPauseMs = (): fc.Arbitrary<number> => fc.integer({ min: 0, max: 3_600_000 })

interface RunningCase {
  state: EngineState
  plan: TimelinePlan
}

/** A `running` engine state with arbitrary start anchor and accumulated pause time. */
const runningState = (spec: fc.Arbitrary<WorkoutSpec> = anySpec()): fc.Arbitrary<RunningCase> =>
  fc
    .record({ spec, startedAtMs: anyEpochMs(), accumulatedPauseMs: anyPauseMs() })
    .map(({ spec: s, startedAtMs, accumulatedPauseMs }) => {
      const plan = buildPlan(s)
      const state: EngineState = {
        spec: s,
        plan,
        status: 'running',
        startedAtMs,
        pausedAtMs: null,
        accumulatedPauseMs,
      }
      return { state, plan }
    })

/** A `paused` engine state whose pause instant is at or after the start anchor. */
const pausedState = (): fc.Arbitrary<RunningCase> =>
  fc
    .record({
      spec: anySpec(),
      startedAtMs: anyEpochMs(),
      pauseOffsetMs: fc.integer({ min: 0, max: 10_000_000 }),
      accumulatedPauseMs: anyPauseMs(),
    })
    .map(({ spec, startedAtMs, pauseOffsetMs, accumulatedPauseMs }) => {
      const plan = buildPlan(spec)
      const state: EngineState = {
        spec,
        plan,
        status: 'paused',
        startedAtMs,
        pausedAtMs: startedAtMs + pauseOffsetMs,
        accumulatedPauseMs,
      }
      return { state, plan }
    })

/** Absolute wall-clock instant at which a segment's end boundary falls. */
const segmentEndAtMs = (state: EngineState, segment: Segment): number =>
  (state.startedAtMs ?? 0) + state.accumulatedPauseMs + segment.offsetMs + segment.durationMs

/* -------------------------------------------------------------------------- */
/* Property 1                                                                  */
/* -------------------------------------------------------------------------- */

describe('Property 1: Elapsed monotonicity', () => {
  /**
   * **Property 1: Elapsed monotonicity**
   *
   * **Validates: Requirement 1.3**
   *
   * While running, effective elapsed time never decreases as the supplied timestamp
   * advances — including across the clamped regions before the start anchor and beyond
   * the end of the workout.
   */
  it('never decreases as the supplied timestamp advances while running', () => {
    fc.assert(
      fc.property(
        runningState(),
        // Offsets from the start anchor, deliberately spanning "before the start"
        // (negative) through "long after the workout ended".
        fc.integer({ min: -1_000_000, max: 40_000_000 }),
        fc.integer({ min: -1_000_000, max: 40_000_000 }),
        ({ state }, offsetA, offsetB) => {
          const startedAtMs = state.startedAtMs as number
          const t1 = startedAtMs + Math.min(offsetA, offsetB)
          const t2 = startedAtMs + Math.max(offsetA, offsetB)

          const e1 = effectiveElapsedMs(state, t1)
          const e2 = effectiveElapsedMs(state, t2)

          expect(t1).toBeLessThanOrEqual(t2)
          expect(e1).toBeLessThanOrEqual(e2)

          // Postcondition: always inside `[0, totalMs]`.
          expect(e1).toBeGreaterThanOrEqual(0)
          expect(e2).toBeLessThanOrEqual(state.plan.totalMs)
        }
      )
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Property 2                                                                  */
/* -------------------------------------------------------------------------- */

describe('Property 2: Pause freezes the clock', () => {
  /**
   * **Property 2: Pause freezes the clock**
   *
   * **Validates: Requirements 1.4, 1.7, 6.3**
   *
   * While paused, effective elapsed time — and therefore the whole snapshot — is
   * identical for every supplied timestamp, and accumulated pause time is excluded from
   * it (which is what keeps a recorded session's total duration free of paused time).
   */
  it('reports the same elapsed time and snapshot for every timestamp while paused', () => {
    fc.assert(
      fc.property(
        pausedState(),
        fc.array(fc.integer({ min: -5_000_000, max: 50_000_000 }), { minLength: 2, maxLength: 12 }),
        ({ state }, offsets) => {
          const startedAtMs = state.startedAtMs as number
          const pausedAtMs = state.pausedAtMs as number

          const frozen = effectiveElapsedMs(state, startedAtMs)
          const frozenSnapshot = snapshot(state, startedAtMs)

          for (const offset of offsets) {
            const now = startedAtMs + offset
            expect(effectiveElapsedMs(state, now)).toBe(frozen)
            expect(snapshot(state, now)).toEqual(frozenSnapshot)
          }

          // Requirements 1.7 / 6.3: the frozen value is the wall-clock span up to the
          // pause instant with all previously accumulated pause time removed.
          const expected = Math.min(
            Math.max(pausedAtMs - startedAtMs - state.accumulatedPauseMs, 0),
            state.plan.totalMs
          )
          expect(frozen).toBe(expected)
        }
      )
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Property 3                                                                  */
/* -------------------------------------------------------------------------- */

describe('Property 3: Background resilience (no drift)', () => {
  /**
   * **Property 3: Background resilience (no drift)**
   *
   * **Validates: Requirements 1.1, 1.2, 1.6**
   *
   * This is the property that pins the original bug shut. The render loop is simulated as
   * an arbitrary monotonic sequence of timestamps with *hidden gaps* of arbitrary length
   * (intervals during which the driver is never invoked at all, exactly as iOS Safari
   * does to a backgrounded tab). Evaluating a single large jump to the final timestamp
   * must yield the same snapshot as stepping through every intermediate timestamp, and
   * the remaining time must equal `absolute segment end − now`, never a tick count.
   */
  it('yields the same snapshot for one large jump as for many small steps summing to it', () => {
    fc.assert(
      fc.property(
        runningState(),
        // Alternating "visible" small steps and "hidden" long gaps.
        fc.array(
          fc.oneof(
            { arbitrary: fc.integer({ min: 1, max: 250 }), weight: 4 }, // visible tick
            { arbitrary: fc.integer({ min: 1_000, max: 5_000_000 }), weight: 1 } // hidden gap
          ),
          { minLength: 1, maxLength: 40 }
        ),
        fc.boolean(),
        ({ state, plan }, deltas, startEarly) => {
          const startedAtMs = state.startedAtMs as number
          // `startEarly` puts the first timestamp before the start anchor, covering the
          // clamped-early region as part of the same walk.
          const originMs = startEarly ? startedAtMs - 5_000 : startedAtMs

          // Stepwise walk: what a driver that fires on every tick would observe. Only the
          // final observation is kept — nothing accumulates between calls.
          let nowMs = originMs
          let stepped = snapshot(state, nowMs)
          for (const delta of deltas) {
            nowMs += delta
            stepped = snapshot(state, nowMs)
          }
          const finalNowMs = nowMs

          // Single-jump walk: what a driver that was suspended for the whole interval and
          // then reconciled once observes.
          const jumped = snapshot(state, finalNowMs)

          // Requirement 1.6: identical phase, round, and remaining milliseconds; in fact
          // the entire snapshot is identical.
          expect(jumped.phase).toBe(stepped.phase)
          expect(jumped.currentRound).toBe(stepped.currentRound)
          expect(jumped.remainingMs).toBe(stepped.remainingMs)
          expect(jumped).toEqual(stepped)

          // Requirement 1.2: purity — re-evaluating the same state and timestamp again
          // reproduces the snapshot exactly.
          expect(snapshot(state, finalNowMs)).toEqual(jumped)

          // Requirement 1.1: remaining time is the distance from `now` to the segment's
          // absolute end boundary, computed here independently of the implementation.
          const rawElapsed = finalNowMs - startedAtMs - state.accumulatedPauseMs
          if (rawElapsed >= 0 && rawElapsed < plan.totalMs) {
            const active = plan.segments.find(
              (seg) => rawElapsed < seg.offsetMs + seg.durationMs
            ) as Segment
            expect(jumped.remainingMs).toBe(segmentEndAtMs(state, active) - finalNowMs)
            expect(jumped.finished).toBe(false)
          } else if (rawElapsed >= plan.totalMs) {
            // Requirement 1.10: a very late resume lands on `finished`.
            expect(jumped.phase).toBe('finished')
            expect(jumped.finished).toBe(true)
          }
        }
      )
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Property 5                                                                  */
/* -------------------------------------------------------------------------- */

describe('Property 5: Phase-transition correctness', () => {
  /**
   * **Property 5: Phase-transition correctness**
   *
   * **Validates: Requirement 2.7**
   *
   * Walking `now` from the start anchor to the end of the workout visits the plan's
   * segments in plan order, each in exactly one contiguous run, skipping none and
   * repeating none, and the walk ends in `finished`. The step size is bounded by the
   * shortest segment so no segment can be stepped over.
   */
  it('visits every segment once, in plan order, and ends finished', () => {
    fc.assert(
      fc.property(
        runningState(shortSpec()),
        // A driver-like step, at most the length of the shortest possible segment (1 s).
        fc.integer({ min: 100, max: 1000 }),
        ({ state, plan }, stepSeed) => {
          const startedAtMs = state.startedAtMs as number
          const shortestSegmentMs = Math.min(...plan.segments.map((seg) => seg.durationMs))
          // Guarantees at least one sample inside every segment.
          const stepMs = Math.max(1, Math.min(stepSeed, shortestSegmentMs))

          const visited: number[] = []
          let previousOffsetMs: number | null = null

          for (let elapsed = 0; elapsed < plan.totalMs; elapsed += stepMs) {
            const nowMs = startedAtMs + state.accumulatedPauseMs + elapsed
            const { segment } = segmentAt(plan, effectiveElapsedMs(state, nowMs))

            if (segment.offsetMs !== previousOffsetMs) {
              visited.push(segment.offsetMs)
              previousOffsetMs = segment.offsetMs
            }

            // The snapshot agrees with the located segment while the workout runs.
            const snap = snapshot(state, nowMs)
            expect(snap.phase).toBe(segment.kind)
            expect(snap.finished).toBe(false)
          }

          // No skips, no repeats, plan order.
          expect(visited).toEqual(plan.segments.map((seg) => seg.offsetMs))

          // Requirement 2.9 / 1.10: the walk terminates in `finished`.
          const endNowMs = startedAtMs + state.accumulatedPauseMs + plan.totalMs
          const endSnapshot = snapshot(state, endNowMs)
          expect(endSnapshot.phase).toBe('finished')
          expect(endSnapshot.finished).toBe(true)
          expect(endSnapshot.elapsedWorkoutMs).toBe(plan.totalMs)
        }
      )
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Property 6                                                                  */
/* -------------------------------------------------------------------------- */

describe('Property 6: Boundary landing', () => {
  /**
   * **Property 6: Boundary landing**
   *
   * **Validates: Requirements 2.8, 2.9**
   *
   * At an elapsed value landing exactly on a segment's end boundary, `segmentAt` returns
   * the immediately following segment (never the one that just ended, never a later one);
   * at `totalMs` it stays on the final segment with nothing remaining, and the snapshot
   * reports `finished`.
   */
  it('returns the next segment at an exact boundary and the last segment at totalMs', () => {
    fc.assert(
      fc.property(anySpec(), (spec) => {
        const plan = buildPlan(spec)

        plan.segments.forEach((segment, at) => {
          const boundaryMs = segment.offsetMs + segment.durationMs
          const next = plan.segments[at + 1]
          const located = segmentAt(plan, boundaryMs)

          if (next) {
            // Requirement 2.8: the following segment becomes active immediately.
            expect(located.segment).toEqual(next)
            expect(located.remainingMs).toBe(next.durationMs)
          } else {
            // Requirement 2.9: the final boundary is `totalMs`; stay on the last segment.
            expect(boundaryMs).toBe(plan.totalMs)
            expect(located.segment).toEqual(segment)
            expect(located.remainingMs).toBe(0)
          }

          // One millisecond before the boundary the original segment is still active.
          const before = segmentAt(plan, boundaryMs - 1)
          expect(before.segment).toEqual(segment)
          expect(before.remainingMs).toBe(1)
        })

        // Requirement 2.9: at `totalMs` the phase is `finished` with the final segment
        // still addressable.
        const startedAtMs = 1_700_000_000_000
        const state: EngineState = {
          spec,
          plan,
          status: 'running',
          startedAtMs,
          pausedAtMs: null,
          accumulatedPauseMs: 0,
        }
        const atTotal = snapshot(state, startedAtMs + plan.totalMs)
        expect(atTotal.phase).toBe('finished')
        expect(atTotal.finished).toBe(true)
        expect(atTotal.remainingMs).toBe(0)
      })
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Property 7                                                                  */
/* -------------------------------------------------------------------------- */

describe('Property 7: Clamp safety', () => {
  /**
   * **Property 7: Clamp safety**
   *
   * **Validates: Requirements 1.9, 1.10**
   *
   * For every engine status and every supplied timestamp — including timestamps far
   * before the start anchor and far beyond the end of the workout — the snapshot stays
   * inside its declared ranges: `remainingMs >= 0`, `progressPct ∈ [0, 100]`, and
   * `elapsedWorkoutMs ∈ [0, totalMs]`.
   */
  it('keeps remainingMs >= 0 and progressPct in [0, 100] for early and very late timestamps', () => {
    const statuses: Array<EngineState['status']> = ['idle', 'running', 'paused', 'finished']

    fc.assert(
      fc.property(
        anySpec(),
        anyEpochMs(),
        anyPauseMs(),
        fc.constantFrom(...statuses),
        fc.oneof(
          // Far in the past, before the workout even started.
          fc.integer({ min: -10_000_000_000, max: -1 }),
          // Somewhere inside (or just around) the workout.
          fc.integer({ min: 0, max: 40_000_000 }),
          // A very late resume, days after the workout should have ended.
          fc.integer({ min: 400_000_000, max: 10_000_000_000 })
        ),
        (spec, startedAtMs, accumulatedPauseMs, status, offsetMs) => {
          const plan = buildPlan(spec)
          const state: EngineState = {
            spec,
            plan,
            status,
            startedAtMs: status === 'idle' ? null : startedAtMs,
            pausedAtMs: status === 'paused' ? startedAtMs + 1_234 : null,
            accumulatedPauseMs,
          }
          const nowMs = startedAtMs + offsetMs

          const elapsed = effectiveElapsedMs(state, nowMs)
          const snap = snapshot(state, nowMs)

          expect(elapsed).toBeGreaterThanOrEqual(0)
          expect(elapsed).toBeLessThanOrEqual(plan.totalMs)

          expect(snap.remainingMs).toBeGreaterThanOrEqual(0)
          expect(snap.remainingMs).toBeLessThanOrEqual(snap.phaseTotalMs)
          expect(snap.progressPct).toBeGreaterThanOrEqual(0)
          expect(snap.progressPct).toBeLessThanOrEqual(100)
          expect(snap.elapsedWorkoutMs).toBeGreaterThanOrEqual(0)
          expect(snap.elapsedWorkoutMs).toBeLessThanOrEqual(plan.totalMs)
          expect(Number.isFinite(snap.remainingMs)).toBe(true)
          expect(Number.isFinite(snap.progressPct)).toBe(true)
          expect(snap.currentRound).toBeGreaterThanOrEqual(1)
          expect(snap.currentRound).toBeLessThanOrEqual(snap.totalRounds)

          // Requirement 1.9: a timestamp earlier than the start clamps elapsed to 0 and
          // leaves the workout unstarted rather than finished.
          if (status === 'running' && offsetMs < 0) {
            expect(elapsed).toBe(0)
            expect(snap.finished).toBe(false)
          }

          // Requirement 1.10: a timestamp beyond start + totalMs clamps to totalMs and
          // reports `finished`.
          if (status === 'running' && offsetMs - accumulatedPauseMs >= plan.totalMs) {
            expect(elapsed).toBe(plan.totalMs)
            expect(snap.phase).toBe('finished')
            expect(snap.finished).toBe(true)
          }
        }
      )
    )
  })
})
