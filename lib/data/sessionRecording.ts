/**
 * Turning a finished (or stopped) run into a history record.
 *
 * Kept pure and separate from the timer view so the two rules that are easy to get wrong are
 * directly testable:
 *
 * 1. **Completed rounds on a stop.** A workout stopped mid-round has completed only the rounds
 *    that *fully elapsed* — the round in progress does not count (requirement 6.2).
 * 2. **Duration.** It is the engine's effective elapsed time, which already excludes every
 *    paused interval, not `endedAt - startedAt` (requirement 6.3).
 *
 * The name and type are copied onto the record rather than referenced, so history stays
 * readable after the workout definition is deleted (requirements 6.4, 6.6).
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import type { TimelinePlan } from '@/lib/timer/types'
import type { WorkoutSessionDTO, WorkoutType } from '@/lib/types'

/** How many `round` segments have fully elapsed at `elapsedMs` (requirement 6.2). */
export function roundsFullyElapsed(plan: TimelinePlan, elapsedMs: number): number {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  return plan.segments.filter(
    (segment) => segment.kind === 'round' && segment.offsetMs + segment.durationMs <= elapsed
  ).length
}

/** The number of rounds the plan schedules. */
export function roundsPlannedIn(plan: TimelinePlan): number {
  return plan.segments.filter((segment) => segment.kind === 'round').length
}

export interface SessionRecordInput {
  /** Client-generated id; the API upserts on it, so a retry stores one row (requirement 8.5). */
  id: string
  /** The workout definition this run came from, when there is one. */
  workoutId?: string | null
  /** Snapshot of the name at recording time (requirement 6.4). */
  workoutName: string
  /** Snapshot of the type at recording time (requirement 6.4). */
  type: WorkoutType
  plan: TimelinePlan
  /** The engine's effective elapsed time at the moment of recording (requirement 6.3). */
  elapsedMs: number
  /** `true` only when the engine reached phase `finished` (requirement 6.1). */
  completed: boolean
  /** Epoch milliseconds when the run started. */
  startedAtMs: number
  /** Epoch milliseconds when the run ended. */
  endedAtMs: number
}

/**
 * Builds the record to persist.
 *
 * A completed run counts every planned round; a stopped one counts the rounds that fully
 * elapsed. Both are clamped into `[0, roundsPlanned]` and the duration into `[0, ∞)`, which is
 * exactly what the sessions API enforces (requirement 6.5) — so a record built here is never
 * rejected for being out of range.
 */
export function buildSessionRecord(input: SessionRecordInput): WorkoutSessionDTO {
  const roundsPlanned = Math.max(1, roundsPlannedIn(input.plan))
  const elapsedMs = Number.isFinite(input.elapsedMs) ? Math.max(0, Math.round(input.elapsedMs)) : 0

  const roundsCompleted = input.completed
    ? roundsPlanned
    : Math.min(roundsPlanned, roundsFullyElapsed(input.plan, elapsedMs))

  return {
    id: input.id,
    workoutId: input.workoutId ?? null,
    workoutName: input.workoutName,
    type: input.type,
    roundsPlanned,
    roundsCompleted,
    totalDurationMs: elapsedMs,
    completed: input.completed,
    startedAt: Math.max(0, Math.round(input.startedAtMs)),
    endedAt: Math.max(0, Math.round(input.endedAtMs)),
  }
}
