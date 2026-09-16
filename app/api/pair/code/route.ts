/**
 * `POST /api/pair/code` — mint a pairing code for the caller's sync space.
 *
 * **This route also enrols the creating device, and that is the easy-to-miss essential part.**
 * If an anonymous device asks for a code, a brand-new sync space is created *and the asking
 * device joins it*; otherwise device B would claim the code, land in an empty space, and device
 * A's existing workouts would never upload. The `201` therefore carries the caller's `userId`
 * (so the client can call `setSession()` without a second request) and, when the caller was
 * anonymous, a `Set-Cookie`.
 *
 * The plaintext code appears in this response body and nowhere else, ever: only its SHA-256
 * digest is persisted, and the TTL comes from `PAIRING_CODE_TTL_MS` alone — never from the
 * request.
 *
 * Requirements: 1.7, 1.8, 1.16, 2.1, 2.2, 2.5, 2.7, 4.4, 8.1, 8.2, 8.3, 8.4, 8.5, 13.1, 13.3
 */

import { NextResponse } from 'next/server'

import {
  databaseUnavailable,
  errorResponse,
  tooManyRequests,
} from '@/lib/data/apiResponses'
import { getPrismaClient } from '@/lib/db'
import {
  MAX_LIVE_CODES_PER_SPACE,
  createSpaceForExistingUser,
  createSyncSpaceWithDevice,
  deviceLabelFrom,
  findSpaceForUser,
  resolveIdentity,
  setDeviceCookie,
} from '@/lib/identity'
import {
  PAIRING_CODE_TTL_MS,
  formatCode,
  generateCode,
  hashCode,
} from '@/lib/pairing/code'
import { SWEEP_INTERVAL_MS, createRateLimiter, ipHashFrom } from '@/lib/pairing/rateLimit'

export const dynamic = 'force-dynamic'

/** Expired rows are deleted only once they are a day stale — housekeeping, never enforcement. */
const CODE_RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * Per-process sweep guard, mirroring the limiter's.
 *
 * Expiry is enforced inside the consumption statement's `WHERE` clause, so this sweep is pure
 * housekeeping: a code stays unclaimable whether or not it has ever run (requirements 2.5, 2.6).
 */
let lastCodeSweepAtMs = 0

async function sweepExpiredCodes(db: {
  pairingCode: {
    deleteMany(args: { where: { expiresAt: { lt: Date } } }): Promise<{ count: number }>
  }
}): Promise<void> {
  const now = Date.now()
  if (now - lastCodeSweepAtMs < SWEEP_INTERVAL_MS) return
  lastCodeSweepAtMs = now

  try {
    await db.pairingCode.deleteMany({
      where: { expiresAt: { lt: new Date(now - CODE_RETENTION_MS) } },
    })
  } catch {
    // Housekeeping only.
  }
}

/** 409 — the space already holds its maximum of live codes (requirement 1.16). */
function liveCodeLimit(): NextResponse {
  return NextResponse.json(
    {
      error: 'This sync space already has the maximum number of active codes. Use one of them.',
      reason: 'code-limit',
    },
    { status: 409 }
  )
}

export async function POST(request: Request): Promise<Response> {
  const ipHash = ipHashFrom(request.headers.get('x-forwarded-for'))

  // The database is resolved before the limiter because the limiter's ledger *is* the database:
  // with none configured, `check` fails closed and would answer `429` where requirement 13.1
  // demands `503`. Nothing about a code has been touched yet, so the "rate limit before any code
  // processing" ordering is intact.
  const db = getPrismaClient()
  if (!db) return databaseUnavailable('not-configured')

  const limiter = createRateLimiter(db)

  try {
    const verdict = await limiter.check(ipHash, 'CREATE')
    if (!verdict.allowed) return tooManyRequests(verdict.retryAfterSeconds)

    const identity = await resolveIdentity()
    if (identity.kind === 'database-error') return databaseUnavailable('unreachable')

    let spaceId: string
    let userId: string
    /** Non-null only when this request minted the identity, i.e. the caller was anonymous. */
    let rawToken: string | null = null

    if (identity.kind === 'anonymous') {
      // Shadow user + space + this device, in one transaction (requirement 8.1).
      const created = await createSyncSpaceWithDevice(
        db,
        deviceLabelFrom(request.headers.get('user-agent'))
      )
      spaceId = created.spaceId
      userId = created.userId
      rawToken = created.rawToken
    } else {
      const existing = await findSpaceForUser(db, identity.userId)
      if (existing) {
        spaceId = existing.id
        userId = existing.userId
      } else {
        // An OAuth caller with no space yet: bind one to their *real* `User` row, so pairing
        // extends the account instead of forking a shadow identity beside it (requirement 8.5).
        const created = await createSpaceForExistingUser(db, identity.userId)
        spaceId = created.id
        userId = created.userId
      }
    }

    const now = new Date()
    const liveCodes = await db.pairingCode.count({
      where: { syncSpaceId: spaceId, consumedAt: null, expiresAt: { gt: now } },
    })

    if (liveCodes >= MAX_LIVE_CODES_PER_SPACE) {
      await limiter.record(ipHash, 'CREATE', false)
      return liveCodeLimit()
    }

    const code = generateCode()
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS)

    await db.pairingCode.create({
      // Only the digest is stored: a database leak must not yield live codes (requirement 1.7).
      data: { syncSpaceId: spaceId, codeHash: hashCode(code), expiresAt },
    })

    await limiter.record(ipHash, 'CREATE', true)
    await sweepExpiredCodes(db)
    await limiter.sweep()

    const response = NextResponse.json(
      {
        // The one and only time the server emits the plaintext (requirement 1.8).
        code: formatCode(code),
        expiresAt: expiresAt.getTime(),
        ttlMs: PAIRING_CODE_TTL_MS,
        userId,
        syncAvailable: true,
      },
      { status: 201 }
    )

    return rawToken ? setDeviceCookie(response, rawToken) : response
  } catch (error) {
    return errorResponse(error)
  }
}
