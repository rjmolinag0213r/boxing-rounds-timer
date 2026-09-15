/**
 * Unit tests for turning a run into a history record.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import { describe, expect, it } from 'vitest'

import { buildSessionRecord, roundsFullyElapsed } from '@/lib/data/sessionRecording'
import { buildPlan } from '@/lib/timer/plan'

// prep 5 s, then 3 × (180 s round + 60 s rest between rounds).
const plan = buildPlan({ prepSeconds: 5, rounds: 3, roundSeconds: 180, restSeconds: 60 })

const base = {
  id: 'session-1',
  workoutName: 'Boxing — Amateur 3×2',
  type: 'BOXING' as const,
  plan,
  startedAtMs: 1_700_000_000_000,
  endedAtMs: 1_700_000_600_000,
}

describe('roundsFullyElapsed (requirement 6.2)', () => {
  it('counts no round before the first one ends', () => {
    // 5 s prep + 179 s into round 1.
    expect(roundsFullyElapsed(plan, 184_000)).toBe(0)
  })

  it('counts a round the instant it ends', () => {
    expect(roundsFullyElapsed(plan, 185_000)).toBe(1)
  })

  it('does not count the round in progress', () => {
    // Round 1 (180 s) + rest (60 s) + 90 s into round 2, from a 5 s prep.
    expect(roundsFullyElapsed(plan, 5_000 + 180_000 + 60_000 + 90_000)).toBe(1)
  })

  it('counts every round at the end of the workout', () => {
    expect(roundsFullyElapsed(plan, plan.totalMs)).toBe(3)
  })

  it('treats a negative or non-finite elapsed time as zero', () => {
    expect(roundsFullyElapsed(plan, -1_000)).toBe(0)
    expect(roundsFullyElapsed(plan, Number.NaN)).toBe(0)
  })
})

describe('buildSessionRecord', () => {
  it('records a finished run with every planned round completed (requirement 6.1)', () => {
    const record = buildSessionRecord({
      ...base,
      elapsedMs: plan.totalMs,
      completed: true,
    })

    expect(record).toMatchObject({
      roundsPlanned: 3,
      roundsCompleted: 3,
      totalDurationMs: plan.totalMs,
      completed: true,
      startedAt: base.startedAtMs,
      endedAt: base.endedAtMs,
    })
  })

  it('records a stopped run with only the fully elapsed rounds (requirement 6.2)', () => {
    const record = buildSessionRecord({
      ...base,
      // Mid-round 2.
      elapsedMs: 5_000 + 180_000 + 60_000 + 90_000,
      completed: false,
    })

    expect(record).toMatchObject({ completed: false, roundsPlanned: 3, roundsCompleted: 1 })
  })

  it('takes the duration from the effective elapsed time, so pauses are excluded (requirement 6.3)', () => {
    // The run spanned 10 minutes of wall clock but the engine reported 4 minutes of work.
    const record = buildSessionRecord({
      ...base,
      startedAtMs: 1_700_000_000_000,
      endedAtMs: 1_700_000_600_000,
      elapsedMs: 240_000,
      completed: false,
    })

    expect(record.totalDurationMs).toBe(240_000)
    expect(record.endedAt - record.startedAt).toBe(600_000)
  })

  it('stores the name and type on the record itself (requirements 6.4, 6.6)', () => {
    const record = buildSessionRecord({
      ...base,
      workoutId: 'workout-7',
      workoutName: 'MMA — Championship 5×5',
      type: 'MMA',
      elapsedMs: 1_000,
      completed: false,
    })

    expect(record).toMatchObject({
      workoutId: 'workout-7',
      workoutName: 'MMA — Championship 5×5',
      type: 'MMA',
    })
  })

  it('clamps a negative elapsed time to a valid duration (requirement 6.5)', () => {
    const record = buildSessionRecord({ ...base, elapsedMs: -5_000, completed: false })

    expect(record.totalDurationMs).toBe(0)
    expect(record.roundsCompleted).toBe(0)
  })

  it('keeps roundsCompleted inside [0, roundsPlanned] for a single-round workout', () => {
    const single = buildPlan({ prepSeconds: 0, rounds: 1, roundSeconds: 60, restSeconds: 0 })
    const record = buildSessionRecord({
      ...base,
      plan: single,
      elapsedMs: 10_000_000,
      completed: false,
    })

    expect(record.roundsPlanned).toBe(1)
    expect(record.roundsCompleted).toBe(1)
  })
})
