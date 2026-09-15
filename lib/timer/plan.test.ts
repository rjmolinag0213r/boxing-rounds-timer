import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { buildPlan } from '@/lib/timer/plan'
import type { WorkoutSpec } from '@/lib/timer/types'

/**
 * Generator for an arbitrary *valid* `WorkoutSpec`, constrained to the authoring bounds
 * (rounds 1–99, round 1–3600 s, rest 0–600 s, prep 0–60 s). Both `restSeconds` and
 * `prepSeconds` reach 0 often enough to exercise the "no rest" / "no prep" plan shapes.
 */
const validSpec = (): fc.Arbitrary<WorkoutSpec> =>
  fc.record({
    rounds: fc.integer({ min: 1, max: 99 }),
    roundSeconds: fc.integer({ min: 1, max: 3600 }),
    restSeconds: fc.oneof(
      { arbitrary: fc.constant(0), weight: 1 },
      { arbitrary: fc.integer({ min: 1, max: 600 }), weight: 3 }
    ),
    prepSeconds: fc.oneof(
      { arbitrary: fc.constant(0), weight: 1 },
      { arbitrary: fc.integer({ min: 1, max: 60 }), weight: 3 }
    ),
  })

describe('Property 4: Plan totals', () => {
  /**
   * **Property 4: Plan totals**
   *
   * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**
   */
  it('sums segment durations to totalMs and emits exactly `rounds` round segments', () => {
    fc.assert(
      fc.property(validSpec(), (spec) => {
        const plan = buildPlan(spec)

        // P4: durations sum to totalMs.
        const durationSum = plan.segments.reduce((sum, seg) => sum + seg.durationMs, 0)
        expect(durationSum).toBe(plan.totalMs)

        // P4: round count matches the spec (requirement 2.1).
        const rounds = plan.segments.filter((seg) => seg.kind === 'round')
        expect(rounds).toHaveLength(spec.rounds)
        expect(rounds.every((seg) => seg.durationMs === spec.roundSeconds * 1000)).toBe(true)

        // Requirement 2.6: offsets are contiguous — each offset equals the sum of all
        // preceding durations — and totalMs closes out the final segment.
        let expectedOffset = 0
        for (const seg of plan.segments) {
          expect(seg.offsetMs).toBe(expectedOffset)
          expect(seg.durationMs).toBeGreaterThan(0)
          expectedOffset += seg.durationMs
        }
        const last = plan.segments[plan.segments.length - 1]
        expect(last.offsetMs + last.durationMs).toBe(plan.totalMs)

        // Requirements 2.2 / 2.3: exactly one prep segment at position 0 iff prepSeconds > 0.
        const preps = plan.segments.filter((seg) => seg.kind === 'prep')
        if (spec.prepSeconds > 0) {
          expect(preps).toHaveLength(1)
          expect(plan.segments[0].kind).toBe('prep')
          expect(plan.segments[0].durationMs).toBe(spec.prepSeconds * 1000)
        } else {
          expect(preps).toHaveLength(0)
          expect(plan.segments[0].kind).toBe('round')
        }

        // Requirements 2.4 / 2.5: `rounds - 1` rests when resting, zero otherwise, each
        // one sitting between two consecutive rounds.
        const rests = plan.segments.filter((seg) => seg.kind === 'rest')
        expect(rests).toHaveLength(spec.restSeconds > 0 ? spec.rounds - 1 : 0)
        for (const rest of rests) {
          const at = plan.segments.indexOf(rest)
          expect(rest.durationMs).toBe(spec.restSeconds * 1000)
          expect(plan.segments[at - 1].kind).toBe('round')
          expect(plan.segments[at + 1]?.kind).toBe('round')
        }
      })
    )
  })
})
