/**
 * `GET /api/pair/devices` — the devices paired into the caller's own sync space.
 *
 * Every read is scoped by the space resolved from the caller's `userId`, which is the whole of
 * the isolation boundary: there is no path here that takes a space id from the request, so one
 * space cannot enumerate another's devices.
 *
 * Requirements: 10.1, 10.2, 13.1, 13.3, 14.6
 */

import { NextResponse } from 'next/server'

import { databaseUnavailable, errorResponse, unauthorized } from '@/lib/data/apiResponses'
import { getPrismaClient } from '@/lib/db'
import { findSpaceForUser, resolveIdentity } from '@/lib/identity'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  // The database is checked before the identity: with none configured every cookie resolves as
  // anonymous, and answering `401` for an unconfigured deployment would be a lie (13.1).
  const db = getPrismaClient()
  if (!db) return databaseUnavailable('not-configured')

  const identity = await resolveIdentity()
  if (identity.kind === 'database-error') return databaseUnavailable('unreachable')
  if (identity.kind === 'anonymous') return unauthorized()

  try {
    const space = await findSpaceForUser(db, identity.userId)

    // A signed-in caller who has never paired owns no space. Not an error — there is simply
    // nothing to list, and `spaceId: null` says so without inventing one.
    if (!space) {
      return NextResponse.json({ devices: [], spaceId: null, rotatedAt: null })
    }

    const devices = await db.pairedDevice.findMany({
      where: { syncSpaceId: space.id },
      select: { id: true, label: true, createdAt: true, lastSeenAt: true },
      orderBy: { createdAt: 'asc' },
    })

    return NextResponse.json({
      devices: devices.map((device) => ({
        id: device.id,
        label: device.label,
        createdAt: device.createdAt.getTime(),
        lastSeenAt: device.lastSeenAt.getTime(),
        isCurrent: device.id === identity.deviceId,
      })),
      spaceId: space.id,
      rotatedAt: space.rotatedAt === null ? null : space.rotatedAt.getTime(),
    })
  } catch (error) {
    return errorResponse(error)
  }
}
