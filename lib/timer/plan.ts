/**
 * Timeline plan construction for the wall-clock timer engine.
 *
 * A {@link TimelinePlan} is derived exactly once from a {@link WorkoutSpec} and is
 * thereafter immutable: it is the absolute, offset-addressed map of the workout that
 * lets every displayed value be computed from `(EngineState, nowMs)` instead of from a
 * decremented counter.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.11
 */

import type { Segment, TimelinePlan, WorkoutSpec } from './types'

/** The `WorkoutSpec` fields that {@link buildPlan} validates. */
export type WorkoutSpecField = keyof WorkoutSpec

/**
 * Raised when a supplied {@link WorkoutSpec} violates a bound.
 *
 * `field` names the offending field so callers (the builder form, the API layer) can
 * attach the message to the right input (requirement 2.11).
 */
export class WorkoutSpecError extends Error {
  readonly field: WorkoutSpecField
  readonly value: number

  constructor(field: WorkoutSpecField, value: number, message: string) {
    super(message)
    this.name = 'WorkoutSpecError'
    this.field = field
    this.value = value
  }
}

const MS_PER_SECOND = 1000

/**
 * Lower bounds from requirement 2.1 / the design's `buildPlan` preconditions.
 *
 * These are the *engine* bounds. The tighter authoring bounds (rounds <= 99,
 * roundSeconds <= 3600, restSeconds <= 600, prepSeconds <= 60) belong to the workout
 * builder's schema, not here: the engine must be able to replay any plan it is given.
 */
const MINIMUMS: ReadonlyArray<readonly [WorkoutSpecField, number]> = [
  ['rounds', 1],
  ['roundSeconds', 1],
  ['restSeconds', 0],
  ['prepSeconds', 0],
]

/**
 * Validates a spec against the bounds in requirement 2.1.
 *
 * @throws {WorkoutSpecError} naming the first offending field.
 */
export function assertValidSpec(spec: WorkoutSpec): void {
  for (const [field, minimum] of MINIMUMS) {
    const value = spec[field]

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new WorkoutSpecError(
        field,
        value,
        `${field} must be a finite number, received ${String(value)}`
      )
    }

    if (value < minimum) {
      throw new WorkoutSpecError(field, value, `${field} must be at least ${minimum}, received ${value}`)
    }
  }
}

/**
 * Builds the ordered, contiguous segment timeline for a workout.
 *
 * Structure, for a spec with `rounds = n`:
 *
 * ```text
 * [prep?] round 1 [rest 1] round 2 [rest 2] … [rest n-1] round n
 * ```
 *
 * - one `prep` segment at position 0 iff `prepSeconds > 0` (requirements 2.2, 2.3)
 * - exactly `n` `round` segments (requirement 2.1)
 * - exactly `n - 1` `rest` segments when `restSeconds > 0`, none otherwise, and never a
 *   trailing rest after the final round (requirements 2.4, 2.5)
 * - each `offsetMs` equals the sum of all preceding durations, and `totalMs` equals the
 *   sum of every duration (requirement 2.6)
 *
 * @throws {WorkoutSpecError} when the spec violates a bound (requirement 2.11).
 */
export function buildPlan(spec: WorkoutSpec): TimelinePlan {
  assertValidSpec(spec)

  const segments: Segment[] = []
  // Loop invariant: `offsetMs` always equals the sum of the durations already appended.
  let offsetMs = 0

  const append = (kind: Segment['kind'], index: number, durationMs: number): void => {
    segments.push({ kind, index, durationMs, offsetMs })
    offsetMs += durationMs
  }

  const prepMs = spec.prepSeconds * MS_PER_SECOND
  const roundMs = spec.roundSeconds * MS_PER_SECOND
  const restMs = spec.restSeconds * MS_PER_SECOND

  if (prepMs > 0) {
    append('prep', 0, prepMs)
  }

  for (let round = 1; round <= spec.rounds; round += 1) {
    append('round', round, roundMs)

    // Rest separates consecutive rounds only: no rest trails the final round.
    if (restMs > 0 && round < spec.rounds) {
      append('rest', round, restMs)
    }
  }

  return { segments, totalMs: offsetMs }
}
