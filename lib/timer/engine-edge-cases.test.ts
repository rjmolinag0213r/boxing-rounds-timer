import { describe, expect, it } from 'vitest'

import { effectiveElapsedMs, segmentAt, snapshot } from '@/lib/timer/compute'
import { assertValidSpec, buildPlan, WorkoutSpecError } from '@/lib/timer/plan'
import type { EngineState, WorkoutSpec } from '@/lib/timer/types'

/**
 * Hand-computed engine edge cases.
 *
 * Every expectation below is a fixed number worked out by hand from the spec, which is
 * what makes these tests a useful complement to the property tests: the properties prove
 * the invariants hold universally, these prove the arithmetic is the arithmetic a boxer
 * would expect.
 *
 * Requirements: 2.3, 2.5, 2.11
 */

const STARTED_AT = 1_700_000_000_000

/** A `running` state anchored at {@link STARTED_AT} with no pause history. */
const running = (spec: WorkoutSpec, accumulatedPauseMs = 0): EngineState => ({
  spec,
  plan: buildPlan(spec),
  status: 'running',
  startedAtMs: STARTED_AT,
  pausedAtMs: null,
  accumulatedPauseMs,
})

/** The snapshot at a given elapsed offset into the workout. */
const atElapsed = (state: EngineState, elapsedMs: number) =>
  snapshot(state, STARTED_AT + state.accumulatedPauseMs + elapsedMs)

describe('rest skipping when restSeconds === 0 (requirement 2.5)', () => {
  const spec: WorkoutSpec = { prepSeconds: 0, rounds: 3, roundSeconds: 60, restSeconds: 0 }

  it('builds three back-to-back rounds and no rest segments', () => {
    const plan = buildPlan(spec)

    expect(plan.segments.map((seg) => seg.kind)).toEqual(['round', 'round', 'round'])
    expect(plan.segments.map((seg) => seg.offsetMs)).toEqual([0, 60_000, 120_000])
    expect(plan.totalMs).toBe(180_000)
  })

  it('moves straight from round 1 into round 2 at the boundary', () => {
    const state = running(spec)

    // Last millisecond of round 1.
    const beforeBoundary = atElapsed(state, 59_999)
    expect(beforeBoundary.phase).toBe('round')
    expect(beforeBoundary.currentRound).toBe(1)
    expect(beforeBoundary.remainingMs).toBe(1)

    // Exactly on the boundary: round 2, full duration, zero progress — no rest in between.
    const onBoundary = atElapsed(state, 60_000)
    expect(onBoundary.phase).toBe('round')
    expect(onBoundary.currentRound).toBe(2)
    expect(onBoundary.remainingMs).toBe(60_000)
    expect(onBoundary.phaseTotalMs).toBe(60_000)
    expect(onBoundary.progressPct).toBe(0)
    expect(onBoundary.elapsedWorkoutMs).toBe(60_000)

    // Halfway through round 3.
    const midRoundThree = atElapsed(state, 150_000)
    expect(midRoundThree.phase).toBe('round')
    expect(midRoundThree.currentRound).toBe(3)
    expect(midRoundThree.remainingMs).toBe(30_000)
    expect(midRoundThree.progressPct).toBe(50)
  })
})

describe('no prep segment when prepSeconds === 0 (requirement 2.3)', () => {
  const spec: WorkoutSpec = { prepSeconds: 0, rounds: 2, roundSeconds: 120, restSeconds: 30 }

  it('starts the workout in round 1 with no prep phase', () => {
    const plan = buildPlan(spec)
    expect(plan.segments.map((seg) => seg.kind)).toEqual(['round', 'rest', 'round'])
    expect(plan.totalMs).toBe(270_000)

    const first = atElapsed(running(spec), 0)
    expect(first.phase).toBe('round')
    expect(first.currentRound).toBe(1)
    expect(first.remainingMs).toBe(120_000)
    expect(first.progressPct).toBe(0)
  })
})

describe('prep, round, and rest sequencing when prepSeconds > 0', () => {
  const spec: WorkoutSpec = { prepSeconds: 5, rounds: 2, roundSeconds: 180, restSeconds: 60 }
  const state = running(spec)

  it('lays out prep -> round 1 -> rest -> round 2 with hand-computed offsets', () => {
    const plan = buildPlan(spec)
    expect(plan.segments).toEqual([
      { kind: 'prep', index: 0, durationMs: 5_000, offsetMs: 0 },
      { kind: 'round', index: 1, durationMs: 180_000, offsetMs: 5_000 },
      { kind: 'rest', index: 1, durationMs: 60_000, offsetMs: 185_000 },
      { kind: 'round', index: 2, durationMs: 180_000, offsetMs: 245_000 },
    ])
    expect(plan.totalMs).toBe(425_000)
  })

  it('reports the hand-computed phase and countdown at each boundary', () => {
    expect(atElapsed(state, 0)).toMatchObject({
      phase: 'prep',
      currentRound: 1,
      remainingMs: 5_000,
      phaseTotalMs: 5_000,
      progressPct: 0,
      finished: false,
    })

    expect(atElapsed(state, 5_000)).toMatchObject({
      phase: 'round',
      currentRound: 1,
      remainingMs: 180_000,
    })

    expect(atElapsed(state, 185_000)).toMatchObject({
      phase: 'rest',
      currentRound: 1,
      remainingMs: 60_000,
    })

    expect(atElapsed(state, 245_000)).toMatchObject({
      phase: 'round',
      currentRound: 2,
      remainingMs: 180_000,
    })

    expect(atElapsed(state, 425_000)).toMatchObject({
      phase: 'finished',
      currentRound: 2,
      remainingMs: 0,
      progressPct: 100,
      elapsedWorkoutMs: 425_000,
      finished: true,
    })
  })

  it('survives a resume long after the workout should have ended', () => {
    // Backgrounded for a full day, then reopened: clamped to finished, not out of range.
    const late = snapshot(state, STARTED_AT + 86_400_000)
    expect(late.phase).toBe('finished')
    expect(late.remainingMs).toBe(0)
    expect(late.elapsedWorkoutMs).toBe(425_000)
  })
})

describe('single-round workouts', () => {
  it('emits one round and no rest even when restSeconds > 0 (requirement 2.5)', () => {
    const spec: WorkoutSpec = { prepSeconds: 0, rounds: 1, roundSeconds: 120, restSeconds: 60 }
    const plan = buildPlan(spec)

    expect(plan.segments).toEqual([{ kind: 'round', index: 1, durationMs: 120_000, offsetMs: 0 }])
    expect(plan.totalMs).toBe(120_000)

    const state = running(spec)
    expect(atElapsed(state, 119_000).remainingMs).toBe(1_000)
    expect(atElapsed(state, 119_000).currentRound).toBe(1)
    expect(atElapsed(state, 120_000)).toMatchObject({ phase: 'finished', finished: true })
  })

  it('keeps prep in front of the only round', () => {
    const spec: WorkoutSpec = { prepSeconds: 10, rounds: 1, roundSeconds: 60, restSeconds: 0 }
    const plan = buildPlan(spec)

    expect(plan.segments.map((seg) => seg.kind)).toEqual(['prep', 'round'])
    expect(plan.totalMs).toBe(70_000)
    expect(segmentAt(plan, 10_000).segment.kind).toBe('round')
    expect(segmentAt(plan, 9_999).segment.kind).toBe('prep')
  })
})

describe('idle and pause arithmetic', () => {
  const spec: WorkoutSpec = { prepSeconds: 0, rounds: 2, roundSeconds: 60, restSeconds: 0 }

  it('reports zero elapsed and the first segment while idle (requirement 2.12)', () => {
    const state: EngineState = {
      spec,
      plan: buildPlan(spec),
      status: 'idle',
      startedAtMs: null,
      pausedAtMs: null,
      accumulatedPauseMs: 0,
    }

    const snap = snapshot(state, STARTED_AT + 999_999)
    expect(snap).toEqual({
      phase: 'idle',
      currentRound: 1,
      totalRounds: 2,
      remainingMs: 60_000,
      phaseTotalMs: 60_000,
      progressPct: 0,
      elapsedWorkoutMs: 0,
      finished: false,
    })
    expect(effectiveElapsedMs(state, STARTED_AT + 999_999)).toBe(0)
  })

  it('freezes the countdown at the pause instant', () => {
    const state: EngineState = {
      spec,
      plan: buildPlan(spec),
      status: 'paused',
      startedAtMs: STARTED_AT,
      pausedAtMs: STARTED_AT + 30_000,
      accumulatedPauseMs: 0,
    }

    const snap = snapshot(state, STARTED_AT + 5_000_000)
    expect(snap.phase).toBe('paused')
    expect(snap.currentRound).toBe(1)
    expect(snap.remainingMs).toBe(30_000)
    expect(snap.elapsedWorkoutMs).toBe(30_000)
  })

  it('excludes a completed pause from elapsed time after resuming', () => {
    // Paused for 45 s, so 90 s of wall-clock time equals 45 s of workout time.
    const state = running(spec, 45_000)
    const snap = snapshot(state, STARTED_AT + 90_000)

    expect(snap.phase).toBe('round')
    expect(snap.currentRound).toBe(1)
    expect(snap.elapsedWorkoutMs).toBe(45_000)
    expect(snap.remainingMs).toBe(15_000)
  })
})

describe('spec validation names the offending field (requirement 2.11)', () => {
  const base: WorkoutSpec = { prepSeconds: 5, rounds: 3, roundSeconds: 60, restSeconds: 30 }

  const cases: Array<[keyof WorkoutSpec, number]> = [
    ['rounds', 0],
    ['rounds', -4],
    ['roundSeconds', 0],
    ['roundSeconds', -1],
    ['restSeconds', -1],
    ['prepSeconds', -1],
  ]

  it.each(cases)('rejects %s = %d and names it in the error', (field, value) => {
    const spec: WorkoutSpec = { ...base, [field]: value }

    expect(() => buildPlan(spec)).toThrow(WorkoutSpecError)

    try {
      buildPlan(spec)
      expect.unreachable('buildPlan should have rejected the out-of-bounds spec')
    } catch (error) {
      const specError = error as WorkoutSpecError
      expect(specError).toBeInstanceOf(WorkoutSpecError)
      expect(specError.name).toBe('WorkoutSpecError')
      expect(specError.field).toBe(field)
      expect(specError.value).toBe(value)
      expect(specError.message).toContain(field)
    }
  })

  it('rejects non-finite values, naming the field', () => {
    expect(() => assertValidSpec({ ...base, rounds: Number.NaN })).toThrowError(/rounds/)
    expect(() => assertValidSpec({ ...base, roundSeconds: Number.POSITIVE_INFINITY })).toThrowError(
      /roundSeconds/
    )
  })

  it('accepts the boundary-valid spec (1 round, 1 s round, no rest, no prep)', () => {
    expect(() =>
      assertValidSpec({ prepSeconds: 0, rounds: 1, roundSeconds: 1, restSeconds: 0 })
    ).not.toThrow()
    expect(buildPlan({ prepSeconds: 0, rounds: 1, roundSeconds: 1, restSeconds: 0 }).totalMs).toBe(1_000)
  })
})
