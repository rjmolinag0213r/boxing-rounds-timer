/**
 * `POST /api/pair/claim` — redeem a pairing code and join its sync space.
 *
 * **The order of the steps in this handler is the security design, not a style choice.** Read the
 * numbered comments below before changing anything here; each one is load-bearing:
 *
 * 1. The rate limit is checked before any code processing, so a limited caller learns nothing.
 * 2. A malformed body takes the *same* exit as a wrong code — never a field-named `400`, because
 *    that would answer instantly for a malformed code while a well-formed miss took a database
 *    round trip, which is precisely the enumeration oracle this design exists to avoid.
 * 3. A code that fails normalization does **not** short-circuit: it is hashed against a sentinel
 *    that cannot match and queried anyway, so syntactic and semantic failures take one path.
 * 4. Repeat offenders are slowed *before* the response is written.
 * 5. Consumption is one atomic conditional `UPDATE`. Absent, expired, and already-consumed all
 *    collapse into `count === 0`, so the handler is structurally incapable of telling them apart
 *    and cannot leak a distinction it never learns. **There is no read of the code row ahead of
 *    this statement** — that is what makes the guarantee structural rather than merely intended.
 * 6. The attempt is recorded on both branches, so probing a spent code costs exactly as much
 *    budget as probing a random string.
 * 7. One uniform `400` for every failure; `200` plus a device cookie for the single success.
 *
 * Requirements: 2.3, 2.6, 3.1–3.6, 4.6, 4.11, 4.15, 5.1–5.7, 9.1, 9.2, 13.1, 13.3, 15.2, 15.8
 */

import { randomBytes } from 'node:crypto'

import { NextResponse } from 'next/server'

import { z } from 'zod'

import {
  databaseUnavailable,
  errorResponse,
  readJsonBody,
  tooManyRequests,
} from '@/lib/data/apiResponses'
import { getPrismaClient } from '@/lib/db'
import {
  MAX_DEVICES_PER_SPACE,
  deviceLabelFrom,
  enrolDevice,
  setDeviceCookie,
} from '@/lib/identity'
import { hashCode, normalizeCode } from '@/lib/pairing/code'
import { BACKOFF_THRESHOLD, backoffMs, createRateLimiter, ipHashFrom } from '@/lib/pairing/rateLimit'

export const dynamic = 'force-dynamic'

/**
 * Deliberately permissive: a trimmed string of 1–32 characters, with **no** alphabet and no exact
 * length check. Those live past the rate limiter so that a malformed code and a wrong-but-
 * well-formed one produce the same status, the same body, and the same timing. 32 is generous
 * enough to absorb dashes and spaces.
 */
const claimRequestSchema = z.object({
  code: z
    .string({ required_error: 'code is required', invalid_type_error: 'code must be a string' })
    .trim()
    .min(1, 'code is required')
    .max(32, 'code must be 32 characters or fewer'),
})

/**
 * A digest that cannot match any stored row.
 *
 * Derived once per process from 32 random bytes, so it is indistinguishable from a real code hash
 * in shape and in query cost, and its preimage is unknown even to this process. Used whenever
 * normalization returns `null`, which is how a malformed code still traverses the database.
 */
const UNMATCHABLE_CODE_HASH = hashCode(randomBytes(32).toString('base64url'))

/** The single uniform failure — identical status, body, and headers for every cause (§7). */
function invalidCode(): NextResponse {
  return NextResponse.json(
    { error: 'That code is not valid. Ask for a new one.', reason: 'invalid-code' },
    { status: 400 }
  )
}

/** 409 — the target space is already at its device cap (requirement 15.2). */
function deviceLimit(): NextResponse {
  return NextResponse.json(
    {
      error: 'That sync space already has the maximum number of devices. Unlink one and retry.',
      reason: 'device-limit',
    },
    { status: 409 }
  )
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export async function POST(request: Request): Promise<Response> {
  // ---- Step 1: the rate limit, before any code processing. -------------------------------
  const ipHash = ipHashFrom(request.headers.get('x-forwarded-for'))

  // The client is resolved first because the limiter's ledger lives in it: with no database,
  // `check` fails closed and would answer `429` where requirement 13.1 demands `503`. No part
  // of the submitted code has been read yet, so the ordering guarantee is untouched.
  const db = getPrismaClient()
  if (!db) return databaseUnavailable('not-configured')

  const limiter = createRateLimiter(db)

  try {
    const verdict = await limiter.check(ipHash, 'CLAIM')
    if (!verdict.allowed) return tooManyRequests(verdict.retryAfterSeconds)

    // ---- Step 2: parse. A malformed body falls through to the same generic 400. ----------
    const parsed = claimRequestSchema.safeParse(await readJsonBody(request))
    const rawCode = parsed.success ? parsed.data.code : ''

    // ---- Step 3: normalize. `null` substitutes a sentinel; it does not return early. -----
    const normalized = normalizeCode(rawCode)
    const codeHash = normalized === null ? UNMATCHABLE_CODE_HASH : hashCode(normalized)

    // ---- Step 4: backoff for repeat offenders, before the response is written. -----------
    if (verdict.consecutiveFailures >= BACKOFF_THRESHOLD) {
      await sleep(backoffMs(verdict.consecutiveFailures))
    }

    // ---- Step 5: one atomic conditional consumption. -------------------------------------
    // Expiry is enforced here, in the `WHERE` clause, so it never depends on a sweep having run
    // (requirements 2.3, 2.6). Row-level locking makes exactly one of any number of concurrent
    // claimants observe `count === 1` (requirement 3.3).
    const now = new Date()
    const consumed = await db.pairingCode.updateMany({
      where: { codeHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    })

    // ---- Step 6 + 7 (failure): record, then the one uniform response. --------------------
    if (consumed.count === 0) {
      await limiter.record(ipHash, 'CLAIM', false)
      return invalidCode()
    }

    // Only now — after the row is already spent and can never be claimed again — is it read.
    // A read here cannot leak anything, because it happens on the success path alone.
    const claimed = await db.pairingCode.findUnique({
      where: { codeHash },
      select: { syncSpaceId: true, syncSpace: { select: { userId: true } } },
    })

    if (!claimed?.syncSpace) {
      // The space vanished between the update and this read — a rotation racing a claim. Not a
      // successful pairing, and counted as a failed attempt like any other.
      await limiter.record(ipHash, 'CLAIM', false)
      return invalidCode()
    }

    const deviceCount = await db.pairedDevice.count({
      where: { syncSpaceId: claimed.syncSpaceId },
    })

    if (deviceCount >= MAX_DEVICES_PER_SPACE) {
      // Recorded as failed, exactly as requirement 15.2 requires. The code is already spent:
      // that is the honest outcome, and unlinking a device makes a fresh code work again.
      await limiter.record(ipHash, 'CLAIM', false)
      return deviceLimit()
    }

    const enrolled = await enrolDevice(
      db,
      claimed.syncSpaceId,
      deviceLabelFrom(request.headers.get('user-agent'))
    )

    await limiter.record(ipHash, 'CLAIM', true)

    return setDeviceCookie(
      NextResponse.json({
        userId: claimed.syncSpace.userId,
        deviceId: enrolled.deviceId,
        spaceId: claimed.syncSpaceId,
      }),
      enrolled.rawToken
    )
  } catch (error) {
    // Never a 401 here: a database fault must not look like "you were signed out".
    return errorResponse(error)
  }
}
