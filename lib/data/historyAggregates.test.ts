/**
 * Unit tests for the history aggregates (task 11.3).
 *
 * The interesting behaviour is entirely at the edges: which sessions the calendar week admits,
 * what an empty history reports, and where the duration format switches from `mm:ss` to
 * `h:mm:ss`. Every case is a fixed, hand-computed expectation — the aggregates have no
 * universally quantified input space worth exploring with generators here.
 *
 * All timestamps are built with the local-time `Date` constructor, the same clock
 * `currentWeekRange` reads, so the assertions hold in any timezone.
 *
 * Requirements: 7.3, 7.4
 */

import { describe, expect, it } from 'vitest'

import {
  computeWeeklyAggregates,
  currentWeekRange,
  formatDurationMs,
  isWithinWeek,
  sortSessionsNewestFirst,
} from './historyAggregates'
import type { WorkoutSessionDTO } from '@/lib/types'

/** Wednesday 12 June 2024, 10:00 local. Its Monday-start week is 10–16 June. */
const NOW = new Date(2024, 5, 12, 10, 0, 0).getTime()

function session(overrides: Partial<WorkoutSessionDTO> & { endedAt: number }): WorkoutSessionDTO {
  return {
    id: `s-${overrides.endedAt}`,
    workoutId: null,
    workoutName: 'Classic 12×3',
    type: 'BOXING',
    roundsPlanned: 12,
    roundsCompleted: 12,
    totalDurationMs: 60_000,
    completed: true,
    startedAt: overrides.endedAt - 60_000,
    ...overrides,
  }
}

describe('currentWeekRange', () => {
  it('spans Monday 00:00 to the instant Monday 00:00 arrives again', () => {
    const week = currentWeekRange(NOW)

    expect(new Date(week.startMs)).toEqual(new Date(2024, 5, 10, 0, 0, 0, 0))
    // Half-open: the exclusive end is the *next* week's first millisecond.
    expect(new Date(week.endMs)).toEqual(new Date(2024, 5, 17, 0, 0, 0, 0))
  })

  it('honours a Sunday-start week', () => {
    const week = currentWeekRange(NOW, { weekStartsOn: 0 })

    expect(new Date(week.startMs)).toEqual(new Date(2024, 5, 9, 0, 0, 0, 0))
    expect(new Date(week.endMs)).toEqual(new Date(2024, 5, 16, 0, 0, 0, 0))
  })
})

describe('isWithinWeek', () => {
  const week = currentWeekRange(NOW)

  it('includes the first millisecond of the week', () => {
    expect(isWithinWeek(week.startMs, week)).toBe(true)
  })

  it('excludes the millisecond before the week starts', () => {
    expect(isWithinWeek(week.startMs - 1, week)).toBe(false)
  })

  it('includes the last millisecond of the week', () => {
    expect(isWithinWeek(week.endMs - 1, week)).toBe(true)
  })

  it('excludes the exclusive end boundary itself', () => {
    expect(isWithinWeek(week.endMs, week)).toBe(false)
  })
})

describe('computeWeeklyAggregates', () => {
  it('reports zeros for an empty history', () => {
    const aggregates = computeWeeklyAggregates([], NOW)

    expect(aggregates.sessionCount).toBe(0)
    expect(aggregates.completedRounds).toBe(0)
    expect(aggregates.totalDurationMs).toBe(0)
    expect(aggregates.week).toEqual(currentWeekRange(NOW))
  })

  it('sums exactly the sessions whose end timestamp falls in the week', () => {
    const week = currentWeekRange(NOW)
    const sessions = [
      // Inside: both boundaries plus one mid-week run.
      session({ endedAt: week.startMs, roundsCompleted: 3, totalDurationMs: 90_000 }),
      session({ endedAt: NOW, roundsCompleted: 12, totalDurationMs: 600_000 }),
      session({ endedAt: week.endMs - 1, roundsCompleted: 5, totalDurationMs: 300_000 }),
      // Outside: one millisecond early, one exactly at the exclusive end, one last week.
      session({ endedAt: week.startMs - 1, roundsCompleted: 99, totalDurationMs: 9_000_000 }),
      session({ endedAt: week.endMs, roundsCompleted: 99, totalDurationMs: 9_000_000 }),
      session({ endedAt: new Date(2024, 5, 4, 8, 0, 0).getTime(), roundsCompleted: 8 }),
    ]

    const aggregates = computeWeeklyAggregates(sessions, NOW)

    expect(aggregates.sessionCount).toBe(3)
    expect(aggregates.completedRounds).toBe(3 + 12 + 5)
    expect(aggregates.totalDurationMs).toBe(90_000 + 600_000 + 300_000)
  })

  it('counts stopped sessions too, using their completed round count', () => {
    const sessions = [
      session({ endedAt: NOW, completed: false, roundsCompleted: 4, totalDurationMs: 240_000 }),
    ]

    const aggregates = computeWeeklyAggregates(sessions, NOW)

    expect(aggregates.sessionCount).toBe(1)
    expect(aggregates.completedRounds).toBe(4)
    expect(aggregates.totalDurationMs).toBe(240_000)
  })

  it('re-partitions when the week start moves', () => {
    // Sunday 9 June: inside a Sunday-start week, outside the Monday-start one.
    const sunday = new Date(2024, 5, 9, 18, 0, 0).getTime()
    const sessions = [session({ endedAt: sunday, roundsCompleted: 6, totalDurationMs: 120_000 })]

    expect(computeWeeklyAggregates(sessions, NOW).sessionCount).toBe(0)
    expect(computeWeeklyAggregates(sessions, NOW, { weekStartsOn: 0 }).sessionCount).toBe(1)
  })
})

describe('formatDurationMs', () => {
  it('renders durations below an hour as mm:ss', () => {
    expect(formatDurationMs(0)).toBe('00:00')
    expect(formatDurationMs(9_000)).toBe('00:09')
    expect(formatDurationMs(65_000)).toBe('01:05')
    expect(formatDurationMs(59 * 60_000 + 59_000)).toBe('59:59')
  })

  it('switches to h:mm:ss at exactly one hour', () => {
    expect(formatDurationMs(3_600_000)).toBe('1:00:00')
    expect(formatDurationMs(3_723_000)).toBe('1:02:03')
    expect(formatDurationMs(12 * 3_600_000 + 34 * 60_000 + 56_000)).toBe('12:34:56')
  })

  it('truncates sub-second remainders and floors invalid input at zero', () => {
    expect(formatDurationMs(1_999)).toBe('00:01')
    expect(formatDurationMs(-5_000)).toBe('00:00')
    expect(formatDurationMs(Number.NaN)).toBe('00:00')
  })
})

describe('sortSessionsNewestFirst', () => {
  it('orders by end timestamp descending without mutating the input', () => {
    const input = [session({ endedAt: 100 }), session({ endedAt: 300 }), session({ endedAt: 200 })]

    const sorted = sortSessionsNewestFirst(input)

    expect(sorted.map((s) => s.endedAt)).toEqual([300, 200, 100])
    expect(input.map((s) => s.endedAt)).toEqual([100, 300, 200])
  })
})
