import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { segmentAt } from '@/lib/timer/compute'
import { buildPlan } from '@/lib/timer/plan'
import { reconcile, segmentKeyOf } from '@/lib/timer/useTimerEngine'
import type { EngineState, WorkoutSpec } from '@/lib/timer/types'

/* -------------------------------------------------------------------------- */
/* Generators                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Arbitrary valid `WorkoutSpec` biased towards *many, short* segments: crossing several
 * boundaries in one reconciliation is exactly the situation P8 is about, and short
 * segments make multi-boundary jumps easy to generate.
 */
const anySpec = (): fc.Arbitrary<WorkoutSpec> =>
  fc.record({
    rounds: fc.integer({ min: 1, max: 12 }),
    roundSeconds: fc.integer({ min: 1, max: 10 }),
    restSeconds: fc.oneof(
      { arbitrary: fc.constant(0), weight: 1 },
      { arbitrary: fc.integer({ min: 1, max: 5 }), weight: 3 }
    ),
    prepSeconds: fc.oneof(
      { arbitrary: fc.constant(0), weight: 1 },
      { arbitrary: fc.integer({ min: 1, max: 5 }), weight: 3 }
    ),
  })

/** Plausible wall-clock epoch milliseconds. */
const anyEpochMs = (): fc.Arbitrary<number> =>
  fc.integer({ min: 1_000_000_000_000, max: 1_800_000_000_000 })

const runningState = (spec: WorkoutSpec, startedAtMs: number, accumulatedPauseMs: number): EngineState => ({
  spec,
  plan: buildPlan(spec),
  status: 'running',
  startedAtMs,
  pausedAtMs: null,
  accumulatedPauseMs,
})

/**
 * One reconciliation of a running workout: the engine was last rendered showing the
 * segment at `prevIndex`, the tab went away, and it comes back at `elapsedMs` into the
 * workout — arbitrarily far ahead, including past the end.
 */
interface ReconcileCase {
  state: EngineState
  prevIndex: number
  elapsedMs: number
  nowMs: number
}

const reconcileCase = (): fc.Arbitrary<ReconcileCase> =>
  fc
    .record({
      spec: anySpec(),
      startedAtMs: anyEpochMs(),
      accumulatedPauseMs: fc.integer({ min: 0, max: 60_000 }),
      prevRatio: fc.double({ min: 0, max: 1, noNaN: true }),
      // Over-1 factors model "resumed after the workout should have ended".
      elapsedFactor: fc.double({ min: 0, max: 1.5, noNaN: true }),
    })
    .map(({ spec, startedAtMs, accumulatedPauseMs, prevRatio, elapsedFactor }) => {
      const state = runningState(spec, startedAtMs, accumulatedPauseMs)
      const segments = state.plan.segments
      const prevIndex = Math.min(segments.length - 1, Math.floor(prevRatio * segments.length))
      const rawElapsed = Math.round(elapsedFactor * state.plan.totalMs)

      // A reconciliation only ever moves forward: `now` is at or after the point at which
      // the previously rendered segment became active.
      const elapsedMs = Math.max(segments[prevIndex].offsetMs, rawElapsed)
      const nowMs = startedAtMs + accumulatedPauseMs + elapsedMs

      return { state, prevIndex, elapsedMs, nowMs }
    })

/* -------------------------------------------------------------------------- */
/* Property 8                                                                  */
/* -------------------------------------------------------------------------- */

describe('Property 8: catch-up sound discipline', () => {
  /**
   * **Property 8: Catch-up sound discipline**
   *
   * A single reconciliation across N crossed segment boundaries emits **at most one**
   * transition sound event, identifying the segment it landed in — never one event per
   * skipped boundary. This is what stops a tab that was backgrounded for ten minutes from
   * firing a burst of stale bells the instant it is foregrounded.
   *
   * **Validates: Requirements 2.10, 4.4**
   */
  it('emits at most one event per reconciliation, however many boundaries were crossed', () => {
    fc.assert(
      fc.property(reconcileCase(), ({ state, prevIndex, elapsedMs, nowMs }) => {
        const segments = state.plan.segments
        const prevSegment = segments[prevIndex]
        const prevKey = segmentKeyOf(prevSegment)

        const result = reconcile(state, prevKey, nowMs)

        // The whole point of P8: one reconciliation, at most one sound.
        expect(result.events.length).toBeLessThanOrEqual(1)

        const landed = segmentAt(state.plan, elapsedMs).segment
        const landedIndex = segments.indexOf(landed)

        // Sanity check on the generator: a reconciliation never travels backwards.
        const crossedBoundaries = landedIndex - prevIndex
        expect(crossedBoundaries).toBeGreaterThanOrEqual(0)

        const finished = elapsedMs >= state.plan.totalMs
        const changedSegment = segmentKeyOf(landed) !== prevKey

        if (finished) {
          // The terminal reconciliation replaces the transition sound with the single
          // `finished` sound: still exactly one event.
          expect(result.events).toHaveLength(1)
          expect(result.events[0].role).toBe('finished')
          expect(result.finished).toBe(true)
        } else if (changedSegment) {
          expect(result.events).toHaveLength(1)
          // The event identifies the *landed* segment, not any skipped one.
          expect(result.events[0].segment).toEqual(landed)
          expect(result.events[0].role).toBe(
            landed.kind === 'prep' ? 'prepStart' : landed.kind === 'rest' ? 'restStart' : 'roundStart'
          )
        } else {
          // Same segment as last time: nothing to announce.
          expect(result.events).toHaveLength(0)
        }

        // Whatever happened, the reported segment key is the landed one, so the *next*
        // reconciliation cannot re-announce it.
        expect(result.segmentKey).toBe(segmentKeyOf(landed))
      }),
      { numRuns: 500 }
    )
  })

  it('emits nothing at all for a non-running engine, at any timestamp', () => {
    fc.assert(
      fc.property(
        anySpec(),
        anyEpochMs(),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.constantFrom<EngineState['status']>('idle', 'paused', 'finished'),
        (spec, startedAtMs, deltaMs, status) => {
          const plan = buildPlan(spec)
          const state: EngineState = {
            spec,
            plan,
            status,
            startedAtMs: status === 'idle' ? null : startedAtMs,
            pausedAtMs: status === 'paused' ? startedAtMs + 1_000 : null,
            accumulatedPauseMs: 0,
          }

          const result = reconcile(state, 'round#1', startedAtMs + deltaMs)

          expect(result.events).toHaveLength(0)
        }
      ),
      { numRuns: 200 }
    )
  })

  it('announces a many-boundary catch-up exactly once (worked example)', () => {
    // prep 5 s, 5 x (10 s round + 5 s rest, no trailing rest) => 5 + 5*10 + 4*5 = 75 s.
    const spec: WorkoutSpec = { prepSeconds: 5, rounds: 5, roundSeconds: 10, restSeconds: 5 }
    const startedAtMs = 1_700_000_000_000
    const state = runningState(spec, startedAtMs, 0)

    // Backgrounded during prep, foregrounded 62 s in: that is inside round 5
    // (prep 0–5, r1 5–15, rest1 15–20, r2 20–30, rest2 30–35, r3 35–45, rest3 45–50,
    //  r4 50–60, rest4 60–65 => 62 s lands in rest after round 4), crossing 8 boundaries.
    const result = reconcile(state, 'prep#0', startedAtMs + 62_000)

    expect(result.events).toHaveLength(1)
    expect(result.events[0].role).toBe('restStart')
    expect(result.events[0].segment).toEqual({ kind: 'rest', index: 4, durationMs: 5_000, offsetMs: 60_000 })
    expect(result.snapshot.phase).toBe('rest')
    expect(result.snapshot.remainingMs).toBe(3_000)
  })
})
