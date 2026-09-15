/**
 * Row <-> DTO conversion for the data routes.
 *
 * Prisma models timestamps as `Date`; the DTOs the browser stores use epoch milliseconds so
 * a record survives `JSON.stringify` and IndexedDB's structured clone without changing shape.
 * These two functions are the only place that conversion happens.
 *
 * Requirements: 6.4, 8.2, 8.3
 */

import type { WorkoutDTO, WorkoutSessionDTO, WorkoutType } from '@/lib/types'

/** The subset of a `Workout` row the client needs. */
export interface WorkoutRow {
  id: string
  name: string
  type: string
  rounds: number
  roundSeconds: number
  restSeconds: number
  prepSeconds: number
  createdAt: Date | string | number
}

/** The subset of a `WorkoutSession` row the client needs. */
export interface WorkoutSessionRow {
  id: string
  workoutId: string | null
  workoutName: string
  type: string
  roundsPlanned: number
  roundsCompleted: number
  totalDurationMs: number
  completed: boolean
  startedAt: Date | string | number
  endedAt: Date | string | number
}

const toEpochMs = (value: Date | string | number): number => {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(ms) ? ms : 0
}

/** Widens the Prisma enum to the client union; unknown values fall back to `BOXING` (5.12). */
const toWorkoutType = (value: string): WorkoutType =>
  value === 'MMA' || value === 'CUSTOM' || value === 'BOXING' ? value : 'BOXING'

export function toWorkoutDTO(row: WorkoutRow): WorkoutDTO {
  return {
    id: row.id,
    name: row.name,
    type: toWorkoutType(row.type),
    rounds: row.rounds,
    roundSeconds: row.roundSeconds,
    restSeconds: row.restSeconds,
    prepSeconds: row.prepSeconds,
    createdAt: toEpochMs(row.createdAt),
  }
}

export function toWorkoutSessionDTO(row: WorkoutSessionRow): WorkoutSessionDTO {
  return {
    id: row.id,
    workoutId: row.workoutId,
    workoutName: row.workoutName,
    type: toWorkoutType(row.type),
    roundsPlanned: row.roundsPlanned,
    roundsCompleted: row.roundsCompleted,
    totalDurationMs: row.totalDurationMs,
    completed: row.completed,
    startedAt: toEpochMs(row.startedAt),
    endedAt: toEpochMs(row.endedAt),
  }
}
