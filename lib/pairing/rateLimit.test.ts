/**
 * Properties 10–13 of the design, plus the limiter shell's behaviour against the in-memory
 * Prisma fake.
 *
 * `evaluate` and `backoffMs` are pure over a list of timestamps and an injected `now`, so the
 * four properties here need no database and no clock control at all — which is the entire
 * reason the module is split the way it is.
 *
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.7, 4.8, 4.9, 4.10, 4.12, 4.13, 4.14, 15.3, 15.4**
 */

import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPrismaFake } from '@/lib/pairing/__fixtures__/prismaFake'
import {
  ATTEMPT_RETENTION_MS,
  BACKOFF_CEILING_MS,
  CLAIM_GLOBAL_RULE,
  CLAIM_RULES,
  CREATE_RULES,
  SWEEP_INTERVAL_MS,
  backoffMs,
  createRateLimiter,
  evaluate,
  ipHashFrom,
  resetSweepGuard,
  type RateLimitRule,
} from '@/lib/pairing/rateLimit'

/* -------------------------------------------------------------------------- */
/* Generators                                                                  */
/* -------------------------------------------------------------------------- */

/** A fixed `now`, so no property here depends on the wall clock. */
const NOW = 1_700_000_000_000

/**
 * An arbitrary rule. `max` is at least 1: a rule with a max of 0 means "never allowed", which
 * no amount of waiting can satisfy, so it is outside the domain of Property 12 rather than a
 * counterexample to it. No rule in this feature is configured that way.
 */
const anyRule = (): fc.Arbitrary<RateLimitRule> =>
  fc.record({
    max: fc.integer({ min: 1, max: 20 }),
    windowMs: fc.integer({ min: 1000, max: 24 * 60 * 60 * 1000 }),
  })

const anyRuleSet = (): fc.Arbitrary<RateLimitRule[]> =>
  fc.array(anyRule(), { minLength: 1, maxLength: 3 })

/**
 * An arbitrary sequence of attempt timestamps mapped into a window around the fixed `now` —
 * some inside every rule's window, some long expired, some (deliberately) in the future, which
 * a clock skew between application servers can genuinely produce.
 */
const anyAttemptTimestamps = (): fc.Arbitrary<number[]> =>
  fc.array(
    fc
      .integer({ min: -30 * 60 * 60 * 1000, max: 60 * 1000 })
      .map((offset) => NOW + offset),
    { maxLength: 40 }
  )

/** The real rule sets, so the properties also cover the shipped configuration. */
const anyRealRuleSet = (): fc.Arbitrary<readonly RateLimitRule[]> =>
  fc.constantFrom(CLAIM_RULES, CREATE_RULES, [CLAIM_GLOBAL_RULE] as const)

/** Counts how many of `timestamps` fall inside `rule`'s window ending at `now`. */
const countInWindow = (
  timestamps: readonly number[],
  rule: RateLimitRule,
  now: number
): number => timestamps.filter((timestamp) => timestamp > now - rule.windowMs).length

/* -------------------------------------------------------------------------- */
/* Property 10                                                                 */
/* -------------------------------------------------------------------------- */

describe('Property 10: Rate-limit accounting never exceeds its budget', () => {
  /**
   * **Property 10: Rate-limit accounting never exceeds its budget**
   *
   * **Validates: Requirements 4.1, 4.2, 4.3, 4.7, 4.9**
   */
  it('allows exactly when every rule has room, and denies otherwise', () => {
    fc.assert(
      fc.property(anyAttemptTimestamps(), anyRuleSet(), (timestamps, rules) => {
        const verdict = evaluate(timestamps, rules, NOW)
        const everyRuleHasRoom = rules.every(
          (rule) => countInWindow(timestamps, rule, NOW) < rule.max
        )

        expect(verdict.allowed).toBe(everyRuleHasRoom)
      }),
      { numRuns: 500 }
    )
  })

  it('never counts more allowed attempts in a window than the rule permits', () => {
    fc.assert(
      fc.property(anyRule(), fc.array(fc.integer({ min: 0, max: 200 }), { maxLength: 60 }), (rule, offsets) => {
        // Replay the offsets as an attempt stream, admitting an attempt only when the limiter
        // says so — exactly as the claim endpoint does.
        const admitted: number[] = []
        for (const offset of offsets) {
          const at = NOW + offset
          if (evaluate(admitted, [rule], at).allowed) admitted.push(at)
        }

        // No window of the rule's length ever contains more than `max` admitted attempts.
        for (const at of admitted) {
          expect(countInWindow(admitted, rule, at)).toBeLessThanOrEqual(rule.max)
        }
      }),
      { numRuns: 300 }
    )
  })

  it('lets an added attempt turn allowed into denied, never the reverse', () => {
    fc.assert(
      fc.property(
        anyAttemptTimestamps(),
        anyRuleSet(),
        fc.integer({ min: -60 * 60 * 1000, max: 0 }).map((offset) => NOW + offset),
        (timestamps, rules, extra) => {
          const before = evaluate(timestamps, rules, NOW).allowed
          const after = evaluate([...timestamps, extra], rules, NOW).allowed

          // after ⇒ before. Equivalently: an extra attempt can only tighten the verdict.
          if (after) expect(before).toBe(true)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('holds for the shipped rule sets too', () => {
    fc.assert(
      fc.property(anyAttemptTimestamps(), anyRealRuleSet(), (timestamps, rules) => {
        const verdict = evaluate(timestamps, rules, NOW)
        expect(verdict.allowed).toBe(
          rules.every((rule) => countInWindow(timestamps, rule, NOW) < rule.max)
        )
      }),
      { numRuns: 300 }
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Property 11                                                                 */
/* -------------------------------------------------------------------------- */

describe('Property 11: Rate-limit capacity recovers after the window', () => {
  /**
   * **Property 11: Rate-limit capacity recovers after the window**
   *
   * **Validates: Requirements 4.10**
   */
  it('allows with no wait once every attempt is older than every window', () => {
    fc.assert(
      fc.property(
        anyRuleSet(),
        fc.array(fc.integer({ min: 1, max: 10 * 60 * 1000 }), { minLength: 1, maxLength: 40 }),
        (rules, ages) => {
          const widest = Math.max(...rules.map((rule) => rule.windowMs))
          // Place every attempt strictly before the widest window opens.
          const timestamps = ages.map((age) => NOW - widest - age)

          const verdict = evaluate(timestamps, rules, NOW)
          expect(verdict.allowed).toBe(true)
          expect(verdict.retryAfterSeconds).toBe(0)
        }
      ),
      { numRuns: 400 }
    )
  })

  it('treats an attempt exactly windowMs old as having left the window', () => {
    const rule: RateLimitRule = { max: 1, windowMs: 60_000 }
    expect(evaluate([NOW - 60_000], [rule], NOW).allowed).toBe(true)
    expect(evaluate([NOW - 59_999], [rule], NOW).allowed).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Property 12                                                                 */
/* -------------------------------------------------------------------------- */

describe('Property 12: Retry-After is a correct lower bound', () => {
  /**
   * **Property 12: Retry-After is a correct lower bound**
   *
   * **Validates: Requirements 4.8**
   */
  it('yields an allowed verdict after waiting exactly the advertised seconds', () => {
    fc.assert(
      fc.property(anyAttemptTimestamps(), anyRuleSet(), (timestamps, rules) => {
        const verdict = evaluate(timestamps, rules, NOW)
        if (verdict.allowed) return

        expect(verdict.retryAfterSeconds).toBeGreaterThanOrEqual(1)

        const later = evaluate(timestamps, rules, NOW + verdict.retryAfterSeconds * 1000)
        expect(later.allowed).toBe(true)
      }),
      { numRuns: 500 }
    )
  })

  it('never under-promises for the shipped rule sets', () => {
    fc.assert(
      fc.property(anyAttemptTimestamps(), anyRealRuleSet(), (timestamps, rules) => {
        const verdict = evaluate(timestamps, rules, NOW)
        if (verdict.allowed) return
        expect(evaluate(timestamps, rules, NOW + verdict.retryAfterSeconds * 1000).allowed).toBe(
          true
        )
      }),
      { numRuns: 300 }
    )
  })

  it('reports whole seconds, rounded up', () => {
    // One attempt 500 ms into a 1-second window with a max of 1: the slot frees in 500 ms,
    // which must be advertised as 1 second rather than 0.
    const verdict = evaluate([NOW - 500], [{ max: 1, windowMs: 1000 }], NOW)
    expect(verdict.allowed).toBe(false)
    expect(verdict.retryAfterSeconds).toBe(1)
    expect(Number.isInteger(verdict.retryAfterSeconds)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Property 13                                                                 */
/* -------------------------------------------------------------------------- */

describe('Property 13: Backoff is monotone and bounded', () => {
  /**
   * **Property 13: Backoff is monotone and bounded**
   *
   * **Validates: Requirements 4.12**
   */
  it('is non-decreasing in the failure count and never exceeds 4000 ms', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (a, b) => {
          const lower = Math.min(a, b)
          const higher = Math.max(a, b)

          expect(backoffMs(lower)).toBeLessThanOrEqual(backoffMs(higher))
          expect(backoffMs(higher)).toBeLessThanOrEqual(BACKOFF_CEILING_MS)
          expect(backoffMs(lower)).toBeGreaterThanOrEqual(0)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('follows min(2^(n-3) * 500, 4000) from the third failure onwards', () => {
    expect(backoffMs(0)).toBe(0)
    expect(backoffMs(1)).toBe(0)
    expect(backoffMs(2)).toBe(0)
    expect(backoffMs(3)).toBe(500)
    expect(backoffMs(4)).toBe(1000)
    expect(backoffMs(5)).toBe(2000)
    expect(backoffMs(6)).toBe(4000)
    expect(backoffMs(7)).toBe(4000)
    expect(backoffMs(100)).toBe(4000)
  })
})

/* -------------------------------------------------------------------------- */
/* The shipped constants                                                       */
/* -------------------------------------------------------------------------- */

describe('the shipped rules (requirements 4.1–4.4)', () => {
  it('caps claims at 5 per 10 minutes and 20 per 24 hours per address', () => {
    expect(CLAIM_RULES).toEqual([
      { max: 5, windowMs: 10 * 60 * 1000 },
      { max: 20, windowMs: 24 * 60 * 60 * 1000 },
    ])
  })

  it('caps claims globally at 60 per minute — the rule the maths rests on', () => {
    expect(CLAIM_GLOBAL_RULE).toEqual({ max: 60, windowMs: 60 * 1000 })
  })

  it('caps code creation at 10 per hour per address', () => {
    expect(CREATE_RULES).toEqual([{ max: 10, windowMs: 60 * 60 * 1000 }])
  })

  it('retains ledger rows for 24 hours and sweeps at most hourly', () => {
    expect(ATTEMPT_RETENTION_MS).toBe(24 * 60 * 60 * 1000)
    expect(SWEEP_INTERVAL_MS).toBe(60 * 60 * 1000)
  })
})

describe('ipHashFrom (requirement 4.18)', () => {
  it('takes the first address of x-forwarded-for and truncates the digest', () => {
    const hash = ipHashFrom('203.0.113.7, 70.41.3.18, 150.172.238.178')
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
    expect(hash).toBe(ipHashFrom('203.0.113.7'))
    expect(hash).not.toBe(ipHashFrom('70.41.3.18'))
  })

  it('buckets an absent header rather than exempting it', () => {
    expect(ipHashFrom(null)).toBe(ipHashFrom(undefined))
    expect(ipHashFrom('')).toBe(ipHashFrom(null))
    expect(ipHashFrom(null)).toMatch(/^[0-9a-f]{32}$/)
  })
})

/* -------------------------------------------------------------------------- */
/* The I/O shell (task 3.8)                                                    */
/* -------------------------------------------------------------------------- */

describe('createRateLimiter against the in-memory fake', () => {
  beforeEach(() => {
    resetSweepGuard()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const ip = ipHashFrom('203.0.113.7')

  it('records exactly one ledger row per processed attempt, success or failure', async () => {
    const fake = createPrismaFake()
    const limiter = createRateLimiter(fake)

    await limiter.record(ip, 'CLAIM', true)
    await limiter.record(ip, 'CLAIM', false)
    await limiter.record(ip, 'CLAIM', false)

    expect(fake.store.pairingAttempts).toHaveLength(3)
    expect(fake.store.pairingAttempts.map((row) => row.succeeded)).toEqual([true, false, false])
    expect(fake.store.pairingAttempts.every((row) => row.kind === 'CLAIM')).toBe(true)
    expect(fake.store.pairingAttempts.every((row) => row.ipHash === ip)).toBe(true)
  })

  it('counts an attempt identically whatever the failure reason (requirement 4.14)', async () => {
    // The ledger row carries no reason field at all, which is what makes this structural
    // rather than a matter of discipline: there is nowhere for a reason to be recorded.
    const fake = createPrismaFake()
    const limiter = createRateLimiter(fake)

    await limiter.record(ip, 'CLAIM', false)
    await limiter.record(ip, 'CLAIM', false)

    const [first, second] = fake.store.pairingAttempts
    expect(Object.keys(first).sort()).toEqual(Object.keys(second).sort())
    expect(Object.keys(first)).not.toContain('reason')
  })

  it('admits the 5th claim in a window and denies the 6th (requirement 4.1)', async () => {
    const fake = createPrismaFake()
    const limiter = createRateLimiter(fake)

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const verdict = await limiter.check(ip, 'CLAIM')
      expect(verdict.allowed).toBe(true)
      await limiter.record(ip, 'CLAIM', false)
    }

    const sixth = await limiter.check(ip, 'CLAIM')
    expect(sixth.allowed).toBe(false)
    expect(sixth.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(sixth.retryAfterSeconds).toBeLessThanOrEqual(600)
  })

  it('recovers once the 10-minute window has rolled past', async () => {
    const fake = createPrismaFake()
    const limiter = createRateLimiter(fake)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await limiter.record(ip, 'CLAIM', false)
    }
    expect((await limiter.check(ip, 'CLAIM')).allowed).toBe(false)

    vi.setSystemTime(new Date(NOW + 10 * 60 * 1000 + 1))
    expect((await limiter.check(ip, 'CLAIM')).allowed).toBe(true)
  })

  it('scopes the per-address budget to the address', async () => {
    const fake = createPrismaFake()
    const limiter = createRateLimiter(fake)
    const other = ipHashFrom('198.51.100.22')

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await limiter.record(ip, 'CLAIM', false)
    }

    expect((await limiter.check(ip, 'CLAIM')).allowed).toBe(false)
    expect((await limiter.check(other, 'CLAIM')).allowed).toBe(true)
  })

  it('applies the global cap across addresses (requirement 4.3)', async () => {
    const fake = createPrismaFake()
    const limiter = createRateLimiter(fake)

    // 60 attempts within the minute, spread across 60 distinct addresses so no per-address
    // rule can be responsible for the denial.
    for (let index = 0; index < 60; index += 1) {
      await limiter.record(ipHashFrom(`203.0.113.${index}`), 'CLAIM', false)
    }

    const fresh = await limiter.check(ipHashFrom('198.51.100.1'), 'CLAIM')
    expect(fresh.allowed).toBe(false)
    expect(fresh.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(fresh.retryAfterSeconds).toBeLessThanOrEqual(60)
  })

  it('leaves code creation free of the global claim cap', async () => {
    const fake = createPrismaFake()
    const limiter = createRateLimiter(fake)

    for (let index = 0; index < 60; index += 1) {
      await limiter.record(ipHashFrom(`203.0.113.${index}`), 'CLAIM', false)
    }

    // One attacker saturating the claim cap must not stop everyone else pairing.
    expect((await limiter.check(ipHashFrom('198.51.100.1'), 'CREATE')).allowed).toBe(true)
  })

  it('caps code creation at 10 per hour per address (requirement 4.4)', async () => {
    const fake = createPrismaFake()
    const limiter = createRateLimiter(fake)

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await limiter.check(ip, 'CREATE')).allowed).toBe(true)
      await limiter.record(ip, 'CREATE', true)
    }

    expect((await limiter.check(ip, 'CREATE')).allowed).toBe(false)
  })

  it('reports consecutive failures, and one success resets them', async () => {
    const fake = createPrismaFake()
    const limiter = createRateLimiter(fake)

    await limiter.record(ip, 'CLAIM', false)
    await limiter.record(ip, 'CLAIM', false)
    expect((await limiter.check(ip, 'CLAIM')).consecutiveFailures).toBe(2)

    await limiter.record(ip, 'CLAIM', true)
    expect((await limiter.check(ip, 'CLAIM')).consecutiveFailures).toBe(0)
  })

  it('feeds backoff only once the third consecutive failure is reached', async () => {
    const fake = createPrismaFake()
    const limiter = createRateLimiter(fake)

    await limiter.record(ip, 'CLAIM', false)
    await limiter.record(ip, 'CLAIM', false)
    expect(backoffMs((await limiter.check(ip, 'CLAIM')).consecutiveFailures)).toBe(0)

    await limiter.record(ip, 'CLAIM', false)
    expect(backoffMs((await limiter.check(ip, 'CLAIM')).consecutiveFailures)).toBe(500)
  })

  it('sweeps only rows older than 24 hours (requirement 15.3)', async () => {
    const fake = createPrismaFake({
      seed: {
        pairingAttempts: [
          { id: 'old', ipHash: ip, kind: 'CLAIM', succeeded: false, createdAt: new Date(NOW - ATTEMPT_RETENTION_MS - 1) },
          { id: 'edge', ipHash: ip, kind: 'CLAIM', succeeded: false, createdAt: new Date(NOW - ATTEMPT_RETENTION_MS) },
          { id: 'recent', ipHash: ip, kind: 'CLAIM', succeeded: false, createdAt: new Date(NOW - 1000) },
        ],
      },
    })
    const limiter = createRateLimiter(fake)

    await limiter.sweep()

    expect(fake.store.pairingAttempts.map((row) => row.id)).toEqual(['edge', 'recent'])
  })

  it('sweeps at most once per hour per process (requirement 15.4)', async () => {
    const seeded = (id: string, ageMs: number) => ({
      id,
      ipHash: ip,
      kind: 'CLAIM' as const,
      succeeded: false,
      createdAt: new Date(NOW - ageMs),
    })

    const fake = createPrismaFake({
      seed: { pairingAttempts: [seeded('a', ATTEMPT_RETENTION_MS + 1)] },
    })
    const limiter = createRateLimiter(fake)

    await limiter.sweep()
    expect(fake.store.pairingAttempts).toHaveLength(0)

    // A second stale row arrives; a sweep within the hour must not run.
    fake.store.pairingAttempts.push(seeded('b', ATTEMPT_RETENTION_MS + 1))
    await limiter.sweep()
    expect(fake.store.pairingAttempts.map((row) => row.id)).toEqual(['b'])

    vi.setSystemTime(new Date(NOW + SWEEP_INTERVAL_MS + 1))
    await limiter.sweep()
    expect(fake.store.pairingAttempts).toHaveLength(0)
  })

  it('treats an absent database as unavailable rather than unlimited', async () => {
    const limiter = createRateLimiter(null)

    const verdict = await limiter.check(ip, 'CLAIM')
    expect(verdict.allowed).toBe(false)

    // …and the write paths are inert rather than throwing, so a route can still answer 503.
    await expect(limiter.record(ip, 'CLAIM', false)).resolves.toBeUndefined()
    await expect(limiter.sweep()).resolves.toBeUndefined()
  })

  it('never lets a ledger write failure become a request failure', async () => {
    const fake = createPrismaFake()
    const exploding = {
      pairingAttempt: {
        ...fake.pairingAttempt,
        create: () => Promise.reject(new Error('ledger unavailable')),
      },
    }

    const limiter = createRateLimiter(exploding)
    await expect(limiter.record(ip, 'CLAIM', false)).resolves.toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/* The fake's load-bearing behaviours (task 3.7)                               */
/* -------------------------------------------------------------------------- */

describe('the in-memory Prisma fake models what the properties depend on', () => {
  it('lets exactly one of many concurrent conditional updates win', async () => {
    const fake = createPrismaFake({
      seed: {
        pairingCodes: [
          {
            id: 'cod_seed',
            syncSpaceId: 'spc_1',
            codeHash: 'a'.repeat(64),
            expiresAt: new Date(NOW + 600_000),
            consumedAt: null,
            createdAt: new Date(NOW),
          },
        ],
      },
    })

    const claim = () =>
      fake.pairingCode.updateMany({
        where: { codeHash: 'a'.repeat(64), consumedAt: null, expiresAt: { gt: new Date(NOW) } },
        data: { consumedAt: new Date(NOW) },
      })

    const results = await Promise.all([claim(), claim(), claim(), claim(), claim()])

    expect(results.filter((result) => result.count === 1)).toHaveLength(1)
    expect(results.filter((result) => result.count === 0)).toHaveLength(4)
    expect(fake.store.pairingCodes[0].consumedAt).not.toBeNull()
  })

  it('honours expiry inside the conditional update, with no prior read', async () => {
    const fake = createPrismaFake({
      seed: {
        pairingCodes: [
          {
            id: 'cod_seed',
            syncSpaceId: 'spc_1',
            codeHash: 'b'.repeat(64),
            expiresAt: new Date(NOW),
            consumedAt: null,
            createdAt: new Date(NOW - 600_000),
          },
        ],
      },
    })

    // `expiresAt > now` is false at exactly `expiresAt`, so the boundary instant is expired.
    const result = await fake.pairingCode.updateMany({
      where: { codeHash: 'b'.repeat(64), consumedAt: null, expiresAt: { gt: new Date(NOW) } },
      data: { consumedAt: new Date(NOW) },
    })

    expect(result.count).toBe(0)
    expect(fake.store.pairingCodes[0].consumedAt).toBeNull()
  })

  it('scopes reads by the where clause, so a missing filter is visible', async () => {
    const fake = createPrismaFake({
      seed: {
        workouts: [
          { id: 'w1', userId: 'usr_a', name: 'A', type: 'BOXING', rounds: 3, roundSeconds: 180, restSeconds: 60, prepSeconds: 5, isDefault: false, createdAt: new Date(NOW), updatedAt: new Date(NOW) },
          { id: 'w2', userId: 'usr_b', name: 'B', type: 'BOXING', rounds: 3, roundSeconds: 180, restSeconds: 60, prepSeconds: 5, isDefault: false, createdAt: new Date(NOW), updatedAt: new Date(NOW) },
        ],
      },
    })

    const scoped = await fake.workout.findMany({ where: { userId: 'usr_a' } })
    expect(scoped.map((row) => row.id)).toEqual(['w1'])

    // No implicit scoping: an unfiltered read returns everything, exactly as Postgres would.
    const unscoped = await fake.workout.findMany()
    expect(unscoped).toHaveLength(2)
  })

  it('throws a P2002-shaped error on a duplicate codeHash or tokenHash', async () => {
    const fake = createPrismaFake()

    await fake.pairingCode.create({
      data: {
        syncSpaceId: 'spc_1',
        codeHash: 'c'.repeat(64),
        expiresAt: new Date(NOW + 600_000),
      },
    })

    await expect(
      fake.pairingCode.create({
        data: {
          syncSpaceId: 'spc_2',
          codeHash: 'c'.repeat(64),
          expiresAt: new Date(NOW + 600_000),
        },
      })
    ).rejects.toMatchObject({ code: 'P2002', meta: { target: ['codeHash'] } })

    await fake.pairedDevice.create({
      data: { syncSpaceId: 'spc_1', tokenHash: 'd'.repeat(64), label: 'Chrome on macOS' },
    })

    await expect(
      fake.pairedDevice.create({
        data: { syncSpaceId: 'spc_1', tokenHash: 'd'.repeat(64), label: 'Safari on iOS' },
      })
    ).rejects.toMatchObject({ code: 'P2002', meta: { target: ['tokenHash'] } })
  })

  it('runs $transaction immediately against the same store', async () => {
    const fake = createPrismaFake()

    const result = await fake.$transaction(async (tx) => {
      const user = await tx.user.create({ data: {} })
      const space = await tx.syncSpace.create({ data: { userId: user.id } })
      return { userId: user.id, spaceId: space.id }
    })

    expect(fake.store.users).toHaveLength(1)
    expect(fake.store.syncSpaces).toHaveLength(1)
    expect(result).toEqual({ userId: 'usr_1', spaceId: 'spc_1' })
  })

  it('resolves a relation select, as identity resolution needs', async () => {
    const fake = createPrismaFake()
    const user = await fake.user.create({ data: {} })
    const space = await fake.syncSpace.create({ data: { userId: user.id } })
    await fake.pairedDevice.create({
      data: { syncSpaceId: space.id, tokenHash: 'e'.repeat(64), label: 'Chrome on macOS' },
    })

    const device = await fake.pairedDevice.findUnique<{
      id: string
      lastSeenAt: Date
      syncSpace: { userId: string }
    }>({
      where: { tokenHash: 'e'.repeat(64) },
      select: { id: true, lastSeenAt: true, syncSpace: { select: { userId: true } } },
    })

    expect(device?.syncSpace.userId).toBe(user.id)
    expect(device).not.toHaveProperty('tokenHash')
  })
})
