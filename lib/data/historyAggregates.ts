/**
 * History aggregates and duration formatting.
 *
 * The history view shows three numbers for the current calendar week — how many sessions were
 * trained, how many rounds were completed, and how much time that took — and each one is an
 * **exact** sum over the sessions whose end timestamp falls inside the week, never a rolling
 * "last 7 days" approximation (requirements 7.3, 7.4).
 *
 * A "calendar week" is a local-time week: it starts at midnight on the week's first day and ends
 * the instant midnight on the following week's first day arrives. The start day is configurable
 * because the requirements do not pin one down; the default is Monday, which is how training
 * weeks are usually counted. The range is half-open — `[startMs, endMs)` — so the boundary
 * instant belongs to exactly one week and a session can never be counted twice.
 *
 * Durations render as `mm:ss` below an hour and `h:mm:ss` from an hour up (requirement 7.2).
 *
 * Everything here is pure: the caller supplies `now`, so the aggregates are deterministic and
 * the view can be rendered from a fixed clock in tests.
 *
 * Requirements: 7.2, 7.3, 7.4
 */

import { endOfWeek, startOfWeek } from 'date-fns'

import type { WorkoutSessionDTO } from '@/lib/types'

/** `0` = Sunday … `6` = Saturday, matching `date-fns`. */
export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** The default first day of the week: Monday. */
export const DEFAULT_WEEK_STARTS_ON: WeekStartsOn = 1

/** A half-open local-time interval: `startMs` is included, `endMs` is not. */
export interface WeekRange {
  /** Epoch milliseconds of midnight on the week's first day. Inclusive. */
  startMs: number
  /** Epoch milliseconds of midnight on the next week's first day. Exclusive. */
  endMs: number
}

/** The three weekly totals the history view puts on top of the list (requirement 7.3). */
export interface WeeklyAggregates {
  /** Number of sessions whose end timestamp falls in the week. */
  sessionCount: number
  /** Exact sum of `roundsCompleted` over those sessions. */
  completedRounds: number
  /** Exact sum of `totalDurationMs` over those sessions. */
  totalDurationMs: number
  /** The week the totals were computed over, so the UI can label it. */
  week: WeekRange
}

export interface WeekOptions {
  /** Which weekday starts the week. Defaults to {@link DEFAULT_WEEK_STARTS_ON}. */
  weekStartsOn?: WeekStartsOn
}

/**
 * The local calendar week containing `nowMs`, as a half-open range.
 *
 * `endOfWeek` returns the last millisecond of the week (`23:59:59.999`), so one millisecond is
 * added to get the exclusive upper bound. Going through `date-fns` rather than arithmetic on
 * `nowMs` keeps daylight-saving weeks (23 or 25 hours long) correct.
 */
export function currentWeekRange(nowMs: number, options: WeekOptions = {}): WeekRange {
  const weekStartsOn = options.weekStartsOn ?? DEFAULT_WEEK_STARTS_ON
  const reference = new Date(nowMs)
  return {
    startMs: startOfWeek(reference, { weekStartsOn }).getTime(),
    endMs: endOfWeek(reference, { weekStartsOn }).getTime() + 1,
  }
}

/** Whether an epoch-millisecond instant falls inside a half-open {@link WeekRange}. */
export function isWithinWeek(timestampMs: number, week: WeekRange): boolean {
  return timestampMs >= week.startMs && timestampMs < week.endMs
}

/**
 * The sessions of `sessions` that ended inside the given week.
 *
 * Exposed separately so a caller can highlight this week's rows in the list without recomputing
 * the membership test.
 */
export function sessionsInWeek(
  sessions: readonly WorkoutSessionDTO[],
  week: WeekRange
): WorkoutSessionDTO[] {
  return sessions.filter((session) => isWithinWeek(session.endedAt, week))
}

/**
 * Exact current-calendar-week totals over `sessions` (requirements 7.3, 7.4).
 *
 * Sessions outside the week contribute nothing, and an empty input yields three zeros rather
 * than an absent result — the view always has numbers to render. Negative or non-finite stored
 * values are floored at zero so one corrupt record cannot drag a total below zero.
 */
export function computeWeeklyAggregates(
  sessions: readonly WorkoutSessionDTO[],
  nowMs: number,
  options: WeekOptions = {}
): WeeklyAggregates {
  const week = currentWeekRange(nowMs, options)
  const inWeek = sessionsInWeek(sessions ?? [], week)

  let completedRounds = 0
  let totalDurationMs = 0
  for (const session of inWeek) {
    completedRounds += nonNegative(session.roundsCompleted)
    totalDurationMs += nonNegative(session.totalDurationMs)
  }

  return {
    sessionCount: inWeek.length,
    completedRounds,
    totalDurationMs,
    week,
  }
}

/**
 * A duration in milliseconds as `mm:ss`, or `h:mm:ss` once it reaches an hour (req 7.2).
 *
 * Minutes and seconds are always two digits; hours are not zero-padded, so 1 h 2 min 3 s reads
 * `1:02:03`. Sub-second remainders truncate downward, so a running total never displays a second
 * that has not fully elapsed.
 */
export function formatDurationMs(milliseconds: number): string {
  const totalSeconds = Math.floor(nonNegative(milliseconds) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')

  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Newest end timestamp first (requirement 7.1). Returns a new array; the input is untouched. */
export function sortSessionsNewestFirst(
  sessions: readonly WorkoutSessionDTO[]
): WorkoutSessionDTO[] {
  return [...(sessions ?? [])].sort((a, b) => b.endedAt - a.endedAt)
}

/** Clamps a possibly missing, negative, or non-finite stored number to a usable total. */
function nonNegative(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
