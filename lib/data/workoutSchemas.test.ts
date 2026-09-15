/**
 * Unit tests for the workout authoring bounds (task 7.4).
 *
 * Every bound in requirement 5.6 is checked at both of its inclusive edges and at the first
 * value past each edge, and every rejection asserts the *named* field so the builder can
 * attach the message to the right input (requirement 5.7).
 *
 * **Validates: Requirements 5.6, 5.7**
 */

import { describe, expect, it } from 'vitest'

import {
  WORKOUT_BOUNDS,
  validateWorkoutDraft,
  workoutDraftSchema,
  type WorkoutIssueField,
} from '@/lib/data/workoutSchemas'

/** A submission that sits comfortably inside every bound. */
const VALID = {
  name: 'Sparring prep',
  type: 'BOXING' as const,
  rounds: 8,
  roundSeconds: 180,
  restSeconds: 60,
  prepSeconds: 5,
}

const draft = (overrides: Record<string, unknown> = {}) => ({ ...VALID, ...overrides })

/** Asserts a rejection and returns the issues, so each case can assert its own field. */
function expectRejected(input: unknown) {
  const result = validateWorkoutDraft(input)
  expect(result.success).toBe(false)
  if (result.success) throw new Error('unreachable: expected a rejection')
  return result
}

function expectAccepted(input: unknown) {
  const result = validateWorkoutDraft(input)
  if (!result.success) {
    throw new Error(`expected acceptance, got: ${JSON.stringify(result.issues)}`)
  }
  return result.data
}

describe('validateWorkoutDraft — accepted values', () => {
  it('accepts a well-formed workout and trims the name', () => {
    expect(expectAccepted(draft({ name: '  Sparring prep  ' }))).toEqual({
      ...VALID,
      name: 'Sparring prep',
    })
  })

  it.each(['BOXING', 'MMA', 'CUSTOM'] as const)('accepts workout type %s', (type) => {
    expect(expectAccepted(draft({ type })).type).toBe(type)
  })

  // Both inclusive edges of every numeric bound in requirement 5.6.
  it.each([
    ['rounds', WORKOUT_BOUNDS.rounds.min],
    ['rounds', WORKOUT_BOUNDS.rounds.max],
    ['roundSeconds', WORKOUT_BOUNDS.roundSeconds.min],
    ['roundSeconds', WORKOUT_BOUNDS.roundSeconds.max],
    ['restSeconds', WORKOUT_BOUNDS.restSeconds.min],
    ['restSeconds', WORKOUT_BOUNDS.restSeconds.max],
    ['prepSeconds', WORKOUT_BOUNDS.prepSeconds.min],
    ['prepSeconds', WORKOUT_BOUNDS.prepSeconds.max],
  ] as const)('accepts %s at its boundary value %i', (field, value) => {
    expect(expectAccepted(draft({ [field]: value }))[field]).toBe(value)
  })

  it.each([WORKOUT_BOUNDS.name.min, WORKOUT_BOUNDS.name.max])(
    'accepts a name of exactly %i characters',
    (length) => {
      const name = 'x'.repeat(length)
      expect(expectAccepted(draft({ name })).name).toBe(name)
    }
  )
})

describe('validateWorkoutDraft — rejected values name the offending field', () => {
  // One past each inclusive edge, plus the empty/whitespace name paths.
  it.each<[string, WorkoutIssueField, Record<string, unknown>]>([
    ['an empty name', 'name', { name: '' }],
    ['a whitespace-only name', 'name', { name: '   ' }],
    ['a 61-character name', 'name', { name: 'x'.repeat(WORKOUT_BOUNDS.name.max + 1) }],
    ['a missing name', 'name', { name: undefined }],
    ['a non-string name', 'name', { name: 42 }],
    ['an unknown workout type', 'type', { type: 'KARATE' }],
    ['a missing workout type', 'type', { type: undefined }],
    ['zero rounds', 'rounds', { rounds: WORKOUT_BOUNDS.rounds.min - 1 }],
    ['100 rounds', 'rounds', { rounds: WORKOUT_BOUNDS.rounds.max + 1 }],
    ['a fractional round count', 'rounds', { rounds: 1.5 }],
    ['a NaN round count', 'rounds', { rounds: Number.NaN }],
    ['an infinite round count', 'rounds', { rounds: Number.POSITIVE_INFINITY }],
    ['a missing round count', 'rounds', { rounds: undefined }],
    ['a zero-second round', 'roundSeconds', { roundSeconds: WORKOUT_BOUNDS.roundSeconds.min - 1 }],
    ['a 3601-second round', 'roundSeconds', { roundSeconds: WORKOUT_BOUNDS.roundSeconds.max + 1 }],
    ['a fractional round duration', 'roundSeconds', { roundSeconds: 90.5 }],
    ['a negative rest', 'restSeconds', { restSeconds: WORKOUT_BOUNDS.restSeconds.min - 1 }],
    ['a 601-second rest', 'restSeconds', { restSeconds: WORKOUT_BOUNDS.restSeconds.max + 1 }],
    ['a non-numeric rest', 'restSeconds', { restSeconds: '60' }],
    ['a negative prep', 'prepSeconds', { prepSeconds: WORKOUT_BOUNDS.prepSeconds.min - 1 }],
    ['a 61-second prep', 'prepSeconds', { prepSeconds: WORKOUT_BOUNDS.prepSeconds.max + 1 }],
    ['a missing prep', 'prepSeconds', { prepSeconds: undefined }],
  ])('rejects %s, naming `%s`', (_label, field, overrides) => {
    const result = expectRejected(draft(overrides))

    expect(result.firstIssue.field).toBe(field)
    expect(result.errors[field]).toBeTruthy()
    // The message opens with the field's own label, so it reads correctly beside the input.
    expect(result.errors[field]!.length).toBeGreaterThan(0)
    expect(result.issues.map((issue) => issue.field)).toContain(field)
  })

  it('reports a form-level issue for a non-object submission', () => {
    expect(expectRejected(null).firstIssue.field).toBe('workout')
    expect(expectRejected('12x3').errors.workout).toBeTruthy()
  })

  it('reports every offending field, ordered as the form presents them', () => {
    const result = expectRejected(draft({ name: '', rounds: 0, prepSeconds: 61 }))

    expect(result.issues.map((issue) => issue.field)).toEqual(['name', 'rounds', 'prepSeconds'])
    expect(result.firstIssue.field).toBe('name')
    expect(Object.keys(result.errors).sort()).toEqual(['name', 'prepSeconds', 'rounds'])
  })

  it('names the bound in the message so the user knows the legal range', () => {
    expect(expectRejected(draft({ rounds: 100 })).errors.rounds).toBe(
      'Rounds must be at most 99'
    )
    expect(expectRejected(draft({ restSeconds: 601 })).errors.restSeconds).toBe(
      'Rest duration must be at most 600 seconds'
    )
    expect(expectRejected(draft({ name: '' })).errors.name).toBe('Name is required')
  })

  it('yields no parsed data to persist when validation fails', () => {
    // Requirement 5.7: a rejected submission carries nothing the caller could store.
    const result = expectRejected(draft({ roundSeconds: 0 }))
    expect(result).not.toHaveProperty('data')
    expect(workoutDraftSchema.safeParse(draft({ roundSeconds: 0 })).success).toBe(false)
  })
})
