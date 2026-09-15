/**
 * Request validation for the workouts and sessions APIs.
 *
 * These are the **server** bounds from the design's "Validation rules" note — `rounds >= 1`,
 * `roundSeconds >= 1`, `restSeconds >= 0`, `prepSeconds >= 0`, `roundsCompleted ∈
 * [0, roundsPlanned]`, `totalDurationMs >= 0`, non-empty `name` of at most 60 characters.
 * They are deliberately looser than the authoring bounds in `workoutSchemas.ts`: the builder
 * refuses to *create* a 10-hour round, but the API must accept any record a previous version
 * of the client legitimately stored rather than stranding it unsynchronized forever.
 *
 * Every failure is reported through {@link fieldErrorsOf}, which keys messages by field name
 * so a 400 response names each invalid field (requirement 8.8).
 *
 * Requirements: 6.5, 8.8
 */

import { z } from 'zod'

import type { WorkoutSessionDTO, WorkoutType } from '@/lib/types'

/** Kept in lockstep with `WorkoutType` in `lib/types.ts` and the Prisma enum. */
const WORKOUT_TYPE_VALUES = ['BOXING', 'MMA', 'CUSTOM'] as const satisfies readonly WorkoutType[]

/** Maximum stored workout-name length (requirement 8.8 / design validation rules). */
export const MAX_NAME_LENGTH = 60

const idSchema = z
  .string({ required_error: 'id is required', invalid_type_error: 'id must be a string' })
  .trim()
  .min(1, 'id is required')
  .max(128, `id must be ${128} characters or fewer`)

const nameSchema = z
  .string({ required_error: 'name is required', invalid_type_error: 'name must be a string' })
  .trim()
  .min(1, 'name must not be empty')
  .max(MAX_NAME_LENGTH, `name must be ${MAX_NAME_LENGTH} characters or fewer`)

const typeSchema = z.enum(WORKOUT_TYPE_VALUES, {
  errorMap: () => ({ message: `type must be one of ${WORKOUT_TYPE_VALUES.join(', ')}` }),
})

/** A whole number at or above `min`. `.int()` also rejects `NaN` and `Infinity`. */
function integerAtLeast(field: string, min: number) {
  return z
    .number({
      required_error: `${field} is required`,
      invalid_type_error: `${field} must be a number`,
    })
    .int(`${field} must be a whole number`)
    .min(min, `${field} must be at least ${min}`)
}

/** Epoch milliseconds. */
const timestampSchema = (field: string) => integerAtLeast(field, 0)

/** The body accepted by `POST /api/workouts` (requirement 8.5 — client-generated `id`). */
export const workoutRequestSchema = z.object({
  id: idSchema,
  name: nameSchema,
  type: typeSchema,
  rounds: integerAtLeast('rounds', 1),
  roundSeconds: integerAtLeast('roundSeconds', 1),
  restSeconds: integerAtLeast('restSeconds', 0),
  prepSeconds: integerAtLeast('prepSeconds', 0),
  createdAt: timestampSchema('createdAt').optional(),
})

export type WorkoutRequest = z.infer<typeof workoutRequestSchema>

/**
 * The body accepted by `POST /api/sessions`.
 *
 * The cross-field rule — a completed round count inside `[0, roundsPlanned]` — is reported on
 * the `roundsCompleted` path so the 400 response names the field the caller has to fix
 * (requirement 6.5).
 */
export const sessionRequestSchema = z
  .object({
    id: idSchema,
    workoutId: idSchema.nullish(),
    workoutName: nameSchema,
    type: typeSchema,
    roundsPlanned: integerAtLeast('roundsPlanned', 1),
    roundsCompleted: integerAtLeast('roundsCompleted', 0),
    totalDurationMs: integerAtLeast('totalDurationMs', 0),
    completed: z.boolean({
      required_error: 'completed is required',
      invalid_type_error: 'completed must be a boolean',
    }),
    startedAt: timestampSchema('startedAt'),
    endedAt: timestampSchema('endedAt'),
  })
  .superRefine((value, ctx) => {
    if (value.roundsCompleted > value.roundsPlanned) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roundsCompleted'],
        message: `roundsCompleted must be between 0 and roundsPlanned (${value.roundsPlanned})`,
      })
    }
  })

export type SessionRequest = z.infer<typeof sessionRequestSchema>

/** The shape a 400 response carries: one message per invalid field (requirement 8.8). */
export type FieldErrors = Record<string, string>

/**
 * Flattens a zod error into `{ field: message }`, keeping the first message per field.
 *
 * A whole-body failure (a non-object payload, say) has an empty issue path and is reported
 * under `body`, so the response always names something actionable.
 */
export function fieldErrorsOf(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {}
  for (const issue of error.issues) {
    const field = issue.path.length > 0 ? issue.path.join('.') : 'body'
    errors[field] ??= issue.message
  }
  return errors
}

export type ValidationOutcome<T> =
  | { success: true; data: T }
  | { success: false; fieldErrors: FieldErrors }

/** Validates a `POST /api/workouts` body. */
export function validateWorkoutRequest(input: unknown): ValidationOutcome<WorkoutRequest> {
  const parsed = workoutRequestSchema.safeParse(input)
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
}

/** Validates a `POST /api/sessions` body. */
export function validateSessionRequest(input: unknown): ValidationOutcome<SessionRequest> {
  const parsed = sessionRequestSchema.safeParse(input)
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
}

/**
 * Narrows a validated session request to the DTO the repository and history view read.
 * Present so the API and the browser storage layer agree on one shape.
 */
export function sessionRequestToDTO(request: SessionRequest): WorkoutSessionDTO {
  return {
    id: request.id,
    workoutId: request.workoutId ?? null,
    workoutName: request.workoutName,
    type: request.type,
    roundsPlanned: request.roundsPlanned,
    roundsCompleted: request.roundsCompleted,
    totalDurationMs: request.totalDurationMs,
    completed: request.completed,
    startedAt: request.startedAt,
    endedAt: request.endedAt,
  }
}
