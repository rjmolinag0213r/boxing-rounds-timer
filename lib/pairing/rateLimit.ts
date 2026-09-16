/**
 * The pairing rate limiter: a pure decision core plus a thin Postgres-backed shell.
 *
 * This module carries most of the security argument for pairing. The keyspace alone does not
 * make an 8-character code safe — `31^8 ≈ 2^39.6` would fall to an unthrottled attacker in
 * hours. The **global** cap of 60 claims a minute is what makes blind guessing hopeless, and
 * any future change to these constants has to be re-checked against the arithmetic in the
 * design's §4.
 *
 * The ledger lives in the application's existing Postgres database rather than in Redis
 * *specifically* so the feature adds zero environment variables. That is the same reason the
 * device credential is an opaque token rather than a signed one.
 *
 * The split between {@link evaluate} — pure, over a list of timestamps and an injected `now`
 * — and {@link createRateLimiter} is what lets every rate-limit property be tested with no
 * database at all.
 *
 * Requirements: 4.1–4.4, 4.7, 4.8, 4.10, 4.12–4.18, 15.3, 15.4, 15.7, 13.9
 */

import { createHash } from 'node:crypto'

/** One rolling-window cap: at most `max` attempts in any `windowMs`. */
export interface RateLimitRule {
  readonly max: number
  readonly windowMs: number
}

/** The limiter's answer for one caller. */
export interface RateLimitVerdict {
  readonly allowed: boolean
  /** Whole seconds until the window frees a slot. Sent as `Retry-After`. 0 when allowed. */
  readonly retryAfterSeconds: number
  /** Consecutive recent failures from this address, which drives {@link backoffMs}. */
  readonly consecutiveFailures: number
}

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Claims, per address: 5 per rolling 10 minutes and 20 per rolling 24 hours (4.1, 4.2). */
export const CLAIM_RULES: readonly RateLimitRule[] = [
  { max: 5, windowMs: 10 * MINUTE_MS },
  { max: 20, windowMs: DAY_MS },
]

/**
 * Claims, globally: 60 per rolling minute (4.3).
 *
 * This is the rule the brute-force arithmetic actually rests on. `x-forwarded-for` is
 * spoofable, so a determined attacker can rotate past the per-address rules; they cannot
 * rotate past this one.
 */
export const CLAIM_GLOBAL_RULE: RateLimitRule = { max: 60, windowMs: MINUTE_MS }

/**
 * Code creation, per address: 10 per rolling hour (4.4).
 *
 * Caps how many live codes an attacker can cause to exist, which is the `L` in the design's
 * `L / K` guessing probability. Rotation reuses it, because rotation mints an identity (4.5).
 */
export const CREATE_RULES: readonly RateLimitRule[] = [{ max: 10, windowMs: HOUR_MS }]

/** Ledger rows older than this are housekeeping, not evidence (requirements 15.3, 15.7). */
export const ATTEMPT_RETENTION_MS = DAY_MS

/** At most one sweep per hour per process — no scheduler, no cron (requirement 15.4). */
export const SWEEP_INTERVAL_MS = HOUR_MS

/** Consecutive failures before a response is deliberately slowed (requirement 4.11). */
export const BACKOFF_THRESHOLD = 3

/** The ceiling on that delay, so backoff cannot become a self-inflicted outage (4.12). */
export const BACKOFF_CEILING_MS = 4000

/** Base delay for the first backed-off attempt. */
const BACKOFF_BASE_MS = 500

/** How many hex characters of the address digest are kept (requirement 4.18). */
export const IP_HASH_LENGTH = 32

/**
 * The verdict for a set of recorded attempt timestamps.
 *
 * Pure: it reads no clock of its own, so every property below is reproducible (4.16). Allowed
 * exactly when *every* rule's in-window count is strictly less than that rule's max (4.7).
 *
 * On denial, `retryAfterSeconds` is the whole seconds until the binding rule's oldest
 * in-window attempt falls out of the window, rounded **up** and floored at 1 — so waiting
 * that long and re-evaluating with no new attempts always yields allowed (4.8). Rounding down
 * would under-promise by up to a second and hand the caller a second `429`.
 */
export function evaluate(
  attemptTimestamps: readonly number[],
  rules: readonly RateLimitRule[],
  now: number
): RateLimitVerdict {
  let retryAfterSeconds = 0

  for (const rule of rules) {
    // A rule with a non-positive max means "never allowed", which no waiting can satisfy. No
    // rule in this feature is configured that way; the branch exists so a future mistake
    // fails closed instead of computing a nonsense delay.
    if (rule.max <= 0) {
      retryAfterSeconds = Math.max(retryAfterSeconds, 1)
      continue
    }

    const windowStart = now - rule.windowMs
    // Strictly greater than the window start: an attempt exactly `windowMs` old has left.
    const inWindow = attemptTimestamps.filter((timestamp) => timestamp > windowStart)

    if (inWindow.length < rule.max) continue

    // Denied by this rule. A slot frees when its oldest in-window attempt ages out; with
    // more attempts in the window than the max, that is the (count - max + 1)th oldest.
    const oldestFirst = [...inWindow].sort((a, b) => a - b)
    const freeingAttempt = oldestFirst[inWindow.length - rule.max]
    const msUntilFree = freeingAttempt + rule.windowMs - now
    const seconds = Math.max(1, Math.ceil(msUntilFree / 1000))

    // The binding rule is the one that keeps the caller waiting longest.
    retryAfterSeconds = Math.max(retryAfterSeconds, seconds)
  }

  return {
    allowed: retryAfterSeconds === 0,
    retryAfterSeconds,
    consecutiveFailures: 0,
  }
}

/**
 * The delay applied to the nth consecutive failure: `min(2^(n-3) * 500, 4000)` ms from the
 * third failure onwards, and nothing before it (requirements 4.11, 4.12).
 *
 * Cheap for someone who mistyped once, expensive for a script, and bounded so it can never
 * become a way to tie up the server.
 */
export function backoffMs(consecutiveFailures: number): number {
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures < BACKOFF_THRESHOLD) return 0

  const exponent = Math.floor(consecutiveFailures) - BACKOFF_THRESHOLD
  // Guard the shift itself: 2 ** 1024 is Infinity, and Math.min(Infinity, ceiling) is the
  // ceiling, but an intermediate NaN would not be. Cap the exponent instead.
  const scaled = BACKOFF_BASE_MS * 2 ** Math.min(exponent, 20)

  return Math.min(scaled, BACKOFF_CEILING_MS)
}

/** The ledger's two attempt kinds, mirroring the `PairingAttemptKind` enum. */
export type AttemptKind = 'CREATE' | 'CLAIM'

/**
 * The slice of the Prisma client this module uses.
 *
 * Structural, not `PrismaClient`, for two reasons: the shell can be handed an in-memory fake
 * with no casting, and this module never imports a client, so it cannot construct one at
 * module load in a build with no `DATABASE_URL` (requirement 13.9).
 */
export interface RateLimitDb {
  pairingAttempt: {
    create(args: {
      data: { ipHash: string; kind: AttemptKind; succeeded: boolean }
    }): Promise<unknown>
    findMany(args: {
      where: { createdAt: { gt: Date } } & { ipHash?: string }
      select: { createdAt: true; succeeded: true }
      orderBy?: { createdAt: 'asc' | 'desc' }
    }): Promise<{ createdAt: Date; succeeded: boolean }[]>
    deleteMany(args: { where: { createdAt: { lt: Date } } }): Promise<{ count: number }>
  }
}

/** The limiter surface the route handlers use. */
export interface RateLimiter {
  check(ipHash: string, kind: AttemptKind): Promise<RateLimitVerdict>
  record(ipHash: string, kind: AttemptKind, succeeded: boolean): Promise<void>
  sweep(): Promise<void>
}

/**
 * Module-level sweep guard.
 *
 * Deliberately per-process rather than shared state: a duplicate sweep in another instance
 * deletes rows that were already going to be deleted, which costs nothing and needs no
 * coordination — and coordination would mean configuration (requirement 15.4).
 */
let lastSweepAtMs = 0

/** Test seam: resets the per-process sweep guard. */
export function resetSweepGuard(): void {
  lastSweepAtMs = 0
}

/** The rules applying to a kind of attempt, per address. */
function rulesFor(kind: AttemptKind): readonly RateLimitRule[] {
  return kind === 'CLAIM' ? CLAIM_RULES : CREATE_RULES
}

/** The longest window any per-address rule for this kind cares about. */
function widestWindowMs(kind: AttemptKind): number {
  return rulesFor(kind).reduce((widest, rule) => Math.max(widest, rule.windowMs), 0)
}

/**
 * Counts the failures at the tail of a chronologically ordered run of attempts.
 *
 * "Consecutive" is counted backwards from the most recent attempt, so one success resets the
 * backoff — which is the behaviour a legitimate user who mistyped twice then got it right
 * should see.
 */
function trailingFailures(attempts: readonly { succeeded: boolean }[]): number {
  let failures = 0
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index].succeeded) break
    failures += 1
  }
  return failures
}

/**
 * Derives `ipHash` from the client address carried by `x-forwarded-for` (requirement 4.18).
 *
 * Being honest about this: an unkeyed hash of an IPv4 address is reversible by brute force,
 * so it is obfuscation against casual inspection, not anonymisation. An HMAC would need a
 * secret, which would break the zero-configuration goal. **Retention is the control** — rows
 * are swept after 24 hours (requirement 15.7).
 *
 * An absent header yields a stable `'unknown'` bucket rather than a free pass: callers behind
 * a proxy that strips the header share one budget, which is strictly safer than exempting
 * them.
 */
export function ipHashFrom(forwardedFor: string | null | undefined): string {
  const first = (forwardedFor ?? '')
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.length > 0)

  return createHash('sha256')
    .update(first ?? 'unknown', 'utf8')
    .digest('hex')
    .slice(0, IP_HASH_LENGTH)
}

/**
 * The I/O shell: reads the ledger, defers every decision to {@link evaluate}, writes one row
 * per processed attempt.
 *
 * A `null` client — no `DATABASE_URL`, or a client that could not be constructed — is treated
 * as **unavailable rather than unlimited**. `check` denies, so a misconfiguration cannot
 * silently switch rate limiting off; the routes answer `503` for an absent database anyway,
 * long before that verdict could be user-visible.
 */
export function createRateLimiter(db: RateLimitDb | null): RateLimiter {
  return {
    async check(ipHash: string, kind: AttemptKind): Promise<RateLimitVerdict> {
      if (!db) {
        // Unavailable, not unlimited. `allowed: false` is the fail-closed direction.
        return { allowed: false, retryAfterSeconds: 1, consecutiveFailures: 0 }
      }

      const now = Date.now()

      const addressAttempts = await db.pairingAttempt.findMany({
        where: { ipHash, createdAt: { gt: new Date(now - widestWindowMs(kind)) } },
        select: { createdAt: true, succeeded: true },
        orderBy: { createdAt: 'asc' },
      })

      const addressVerdict = evaluate(
        addressAttempts.map((attempt) => attempt.createdAt.getTime()),
        rulesFor(kind),
        now
      )

      // Consecutive failures are an address-scoped notion: it is this caller who is being
      // slowed down, not everyone.
      const consecutiveFailures = trailingFailures(addressAttempts)

      // Only claims carry a global cap. Code creation is already bounded per address and by
      // the 3-live-codes-per-space cap, and a global create cap would let one attacker deny
      // pairing to everybody.
      if (kind !== 'CLAIM') {
        return { ...addressVerdict, consecutiveFailures }
      }

      const globalAttempts = await db.pairingAttempt.findMany({
        where: { createdAt: { gt: new Date(now - CLAIM_GLOBAL_RULE.windowMs) } },
        select: { createdAt: true, succeeded: true },
      })

      const globalVerdict = evaluate(
        globalAttempts.map((attempt) => attempt.createdAt.getTime()),
        [CLAIM_GLOBAL_RULE],
        now
      )

      // The binding verdict: denied if either scope denies, and the longer wait wins.
      return {
        allowed: addressVerdict.allowed && globalVerdict.allowed,
        retryAfterSeconds: Math.max(
          addressVerdict.retryAfterSeconds,
          globalVerdict.retryAfterSeconds
        ),
        consecutiveFailures,
      }
    },

    /**
     * Exactly one ledger row per processed attempt, on the success path and on every failure
     * path alike (requirements 4.13, 4.14). A failed write is swallowed: the attempt has
     * already happened, and turning a ledger hiccup into a 500 would be worse than
     * under-counting one attempt.
     */
    async record(ipHash: string, kind: AttemptKind, succeeded: boolean): Promise<void> {
      if (!db) return

      try {
        await db.pairingAttempt.create({ data: { ipHash, kind, succeeded } })
      } catch {
        // Deliberately silent — see above.
      }
    },

    /**
     * Deletes ledger rows older than 24 hours, at most once per hour per process
     * (requirements 15.3, 15.4). Opportunistic housekeeping, never a security dependency:
     * every window query filters on `createdAt` regardless of whether a sweep has run.
     */
    async sweep(): Promise<void> {
      if (!db) return

      const now = Date.now()
      if (now - lastSweepAtMs < SWEEP_INTERVAL_MS) return
      // Claim the slot before awaiting, so two concurrent requests cannot both sweep.
      lastSweepAtMs = now

      try {
        await db.pairingAttempt.deleteMany({
          where: { createdAt: { lt: new Date(now - ATTEMPT_RETENTION_MS) } },
        })
      } catch {
        // Housekeeping only.
      }
    },
  }
}
