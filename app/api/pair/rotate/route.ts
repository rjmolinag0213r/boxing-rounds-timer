/**
 * `POST /api/pair/rotate` — abandon this sync space and start a new one, keeping the data.
 *
 * This is the answer to "I showed the code to the wrong person", and the only destructive action
 * in the feature. In one transaction it mints a fresh shadow `User` and `SyncSpace`, re-points
 * every `Workout` and `WorkoutSession` of the old identity at the new one, and deletes every old
 * device and every old code — so the caller keeps their records and every other device is out.
 *
 * The calling browser is re-enrolled inside the same transaction and given a fresh cookie;
 * without that it would revoke itself along with everyone else.
 *
 * `CREATE_RULES` applies here because rotation mints an identity, exactly as code creation can
 * (requirement 4.5).
 *
 * Requirements: 4.5, 10.8–10.14, 13.1, 13.3
 */

import { NextResponse } from 'next/server'

import {
  databaseUnavailable,
  errorResponse,
  tooManyRequests,
  unauthorized,
} from '@/lib/data/apiResponses'
import { getPrismaClient } from '@/lib/db'
import {
  deviceLabelFrom,
  enrolDevice,
  findSpaceForUser,
  resolveIdentity,
  setDeviceCookie,
} from '@/lib/identity'
import { createRateLimiter, ipHashFrom } from '@/lib/pairing/rateLimit'

export const dynamic = 'force-dynamic'

/** What the transaction hands back. */
interface Rotation {
  userId: string
  spaceId: string
  revokedDevices: number
  rawToken: string
}

export async function POST(request: Request): Promise<Response> {
  const db = getPrismaClient()
  if (!db) return databaseUnavailable('not-configured')

  const identity = await resolveIdentity()
  if (identity.kind === 'database-error') return databaseUnavailable('unreachable')
  if (identity.kind === 'anonymous') return unauthorized()

  const ipHash = ipHashFrom(request.headers.get('x-forwarded-for'))
  const limiter = createRateLimiter(db)

  try {
    const verdict = await limiter.check(ipHash, 'CREATE')
    if (!verdict.allowed) return tooManyRequests(verdict.retryAfterSeconds)

    const oldSpace = await findSpaceForUser(db, identity.userId)

    // A signed-in caller who never paired has no space to rotate. Reported as absent rather
    // than silently creating one, since rotation is a remedy and there is nothing to remedy.
    if (!oldSpace) {
      return NextResponse.json({ error: 'No sync space to rotate', reason: 'no-space' }, { status: 404 })
    }

    const rotatedAt = new Date()
    const label = deviceLabelFrom(request.headers.get('user-agent'))

    const rotated = (await db.$transaction(async (tx) => {
      const user = await tx.user.create({ data: {} })
      const space = await tx.syncSpace.create({ data: { userId: user.id, rotatedAt } })

      // Both are indexed on `userId`, and a personal timer's record count is in the hundreds.
      await tx.workout.updateMany({
        where: { userId: identity.userId },
        data: { userId: user.id },
      })
      await tx.workoutSession.updateMany({
        where: { userId: identity.userId },
        data: { userId: user.id },
      })

      // Counted before the caller's own re-enrolment, so `revokedDevices` is the number of
      // devices that actually lost access — the caller's old device among them.
      const revoked = await tx.pairedDevice.deleteMany({ where: { syncSpaceId: oldSpace.id } })
      await tx.pairingCode.deleteMany({ where: { syncSpaceId: oldSpace.id } })

      const enrolled = await enrolDevice(tx, space.id, label)

      return {
        userId: user.id,
        spaceId: space.id,
        revokedDevices: revoked.count,
        rawToken: enrolled.rawToken,
      }
    })) as Rotation

    await limiter.record(ipHash, 'CREATE', true)

    return setDeviceCookie(
      NextResponse.json({
        userId: rotated.userId,
        spaceId: rotated.spaceId,
        revokedDevices: rotated.revokedDevices,
      }),
      rotated.rawToken
    )
  } catch (error) {
    return errorResponse(error)
  }
}
