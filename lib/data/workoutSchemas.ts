/**
 * Authoring-time validation for user-created workouts.
 *
 * These are the **builder** bounds (requirement 5.6), which are deliberately tighter than
 * the engine bounds enforced by `buildPlan` in `lib/timer/plan.ts`: the engine must be able
 * to replay any plan it is handed, while the builder refuses to author a 10-hour round.
 *
 * Every message names the field it belongs to, and {@link validateWorkoutDraft} returns the
 * issues keyed by field so the builder form can attach each message to its own input and
 * retain the user's entered values instead of discarding them (requirement 5.7).
 *
 * Requirements: 5.6, 5.7
 */

import { z } from 'zod'

import type { WorkoutType } from '@/lib/presets'

/** The editable fields of a workout, in the order the builder form presents them. */
export const WORKOUT_FIELDS = [
  'name',
  'type',
  'rounds',
  'roundSeconds',
  'restSeconds',
  'prepSeconds',
] as const

export type WorkoutField = (typeof WORKOUT_FIELDS)[number]

/**
 * A validation issue that concerns the submission as a whole rather than one field —
 * for example a non-object payload. The form surfaces it as a form-level message.
 */
export const WORKOUT_FORM_FIELD = 'workout' as const

export type WorkoutIssueField = WorkoutField | typeof WORKOUT_FORM_FIELD

/** The inclusive bounds from requirement 5.6. Exported so the UI can bound its inputs. */
export const WORKOUT_BOUNDS = {
  /** Name length in characters, measured after trimming. */
  name: { min: 1, max: 60 },
  rounds: { min: 1, max: 99 },
  /** Round duration in seconds. */
  roundSeconds: { min: 1, max: 3600 },
  /** Rest duration in seconds; 0 means "no rest between rounds". */
  restSeconds: { min: 0, max: 600 },
  /** Lead-in duration in seconds; 0 means "no lead-in". */
  prepSeconds: { min: 0, max: 60 },
} as const

/** Human-readable field names used to open every validation message. */
export const WORKOUT_FIELD_LABELS: Record<WorkoutIssueField, string> = {
  name: 'Name',
  type: 'Workout type',
  rounds: 'Rounds',
  roundSeconds: 'Round duration',
  restSeconds: 'Rest duration',
  prepSeconds: 'Prep duration',
  workout: 'Workout',
}

/** Kept in lockstep with `WorkoutType` in `lib/presets.ts`. */
const WORKOUT_TYPE_VALUES = ['BOXING', 'MMA', 'CUSTOM'] as const satisfies readonly WorkoutType[]

/**
 * A bounded, whole-number field.
 *
 * Fractional and non-numeric input is rejected rather than rounded: silently reshaping a
 * value the user typed would contradict "retain the user's entered values".
 *
 * @param unit appended to the bound messages ("at least 1 seconds"); omit for a bare count.
 */
function boundedIntegerField(
  field: Exclude<WorkoutField, 'name' | 'type'>,
  unit?: string
) {
  const label = WORKOUT_FIELD_LABELS[field]
  const { min, max } = WORKOUT_BOUNDS[field]
  const suffix = unit ? ` ${unit}` : ''

  return z
    .number({
      required_error: `${label} is required`,
      invalid_type_error: `${label} must be a number`,
    })
    // `z.number()` already rejects `NaN`; `.int()` additionally rejects `Infinity`.
    .int(`${label} must be a whole number${unit ? ` of ${unit}` : ''}`)
    .min(min, `${label} must be at least ${min}${suffix}`)
    .max(max, `${label} must be at most ${max}${suffix}`)
}

export const workoutNameSchema = z
  .string({
    required_error: `${WORKOUT_FIELD_LABELS.name} is required`,
    invalid_type_error: `${WORKOUT_FIELD_LABELS.name} must be text`,
  })
  // `trim` runs before the length checks, so "   " fails the 1-character minimum.
  .trim()
  .min(WORKOUT_BOUNDS.name.min, `${WORKOUT_FIELD_LABELS.name} is required`)
  .max(
    WORKOUT_BOUNDS.name.max,
    `${WORKOUT_FIELD_LABELS.name} must be ${WORKOUT_BOUNDS.name.max} characters or fewer`
  )

export const workoutTypeSchema = z.enum(WORKOUT_TYPE_VALUES, {
  errorMap: () => ({
    message: `${WORKOUT_FIELD_LABELS.type} must be one of ${WORKOUT_TYPE_VALUES.join(', ')}`,
  }),
})

export const workoutRoundsSchema = boundedIntegerField('rounds')
export const roundDurationSchema = boundedIntegerField('roundSeconds', 'seconds')
export const restDurationSchema = boundedIntegerField('restSeconds', 'seconds')
export const prepDurationSchema = boundedIntegerField('prepSeconds', 'seconds')

/** The full submission shape the builder validates before persisting (requirement 5.6). */
export const workoutDraftSchema = z.object({
  name: workoutNameSchema,
  type: workoutTypeSchema,
  rounds: workoutRoundsSchema,
  roundSeconds: roundDurationSchema,
  restSeconds: restDurationSchema,
  prepSeconds: prepDurationSchema,
})

/** A validated workout, with `name` already trimmed. */
export type WorkoutDraft = z.infer<typeof workoutDraftSchema>

export interface WorkoutValidationIssue {
  field: WorkoutIssueField
  message: string
}

export type WorkoutValidationResult =
  | { success: true; data: WorkoutDraft }
  | {
      success: false
      /** Every issue, ordered by the field order in {@link WORKOUT_FIELDS}. */
      issues: WorkoutValidationIssue[]
      /** The first issue per field — what the form renders under each input. */
      errors: Partial<Record<WorkoutIssueField, string>>
      /** The issue to announce (a toast, an API message); never undefined on failure. */
      firstIssue: WorkoutValidationIssue
    }

const FIELD_ORDER: readonly WorkoutIssueField[] = [...WORKOUT_FIELDS, WORKOUT_FORM_FIELD]

function isWorkoutField(value: unknown): value is WorkoutField {
  return typeof value === 'string' && (WORKOUT_FIELDS as readonly string[]).includes(value)
}

/** Maps a zod issue path onto the field the message belongs to. */
function fieldOf(path: readonly (string | number)[]): WorkoutIssueField {
  const head = path[0]
  return isWorkoutField(head) ? head : WORKOUT_FORM_FIELD
}

/**
 * Validates an arbitrary submission against {@link workoutDraftSchema}.
 *
 * On failure the caller gets a per-field message map and never a parsed value, so there is
 * nothing to persist — the entered values stay wherever the caller is holding them
 * (requirement 5.7).
 */
export function validateWorkoutDraft(input: unknown): WorkoutValidationResult {
  const parsed = workoutDraftSchema.safeParse(input)
  if (parsed.success) return { success: true, data: parsed.data }

  const issues: WorkoutValidationIssue[] = parsed.error.issues
    .map((issue) => ({ field: fieldOf(issue.path), message: issue.message }))
    .sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field))

  const errors: Partial<Record<WorkoutIssueField, string>> = {}
  for (const issue of issues) {
    errors[issue.field] ??= issue.message
  }

  // zod always reports at least one issue for a failed parse.
  return { success: false, issues, errors, firstIssue: issues[0] }
}
