/**
 * `DELETE /api/pair/devices/[id]` — unlink one device.
 *
 * The delete is scoped by the caller's own space in the *same* statement that matches the id, so
 * an id that does not exist and an id belonging to somebody else both produce `count === 0` and
 * therefore the identical `404`. Ownership is never disclosed — the same pattern
 * `POST /api/workouts` already uses for a foreign workout id.
 *
 * Unlinking the caller's own device additionally clears the cookie, so that browser drops back
 * to local-only on its next request with its local records intact.
 *
 * Requirements: 10.3, 10.4, 10.5, 10.6, 13.1, 13.3, 14.6
 */

import { NextResponse } from 'next/server'

import { databaseUnavailable, errorResponse, unauthorized } from '@/lib/data/apiResponses'
import { getPrismaClient } from '@/lib/db'
import { clearDeviceCookie, findSpaceForUser, resolveIdentity } from '@/lib/identity'

export const dynamic = 'force-dynamic'

/** One body for both "no such device" and "not your device" (requirement 10.4). */
function deviceNotFound(): NextResponse {
  return NextResponse.json({ error: 'Device not found' }, { status: 404 })
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  const db = getPrismaClient()
  if (!db) return databaseUnavailable('not-configured')

  const identity = await resolveIdentity()
  if (identity.kind === 'database-error') return databaseUnavailable('unreachable')
  if (identity.kind === 'anonymous') return unauthorized()

  try {
    const space = await findSpaceForUser(db, identity.userId)
    if (!space) return deviceNotFound()

    // `wasCurrent` is read before the delete, since afterwards there is no row to compare.
    const wasCurrent = params.id === identity.deviceId

    const deleted = await db.pairedDevice.deleteMany({
      where: { id: params.id, syncSpaceId: space.id },
    })

    if (deleted.count === 0) return deviceNotFound()

    const response = NextResponse.json({ id: params.id, wasCurrent })
    return wasCurrent ? clearDeviceCookie(response) : response
  } catch (error) {
    return errorResponse(error)
  }
}
