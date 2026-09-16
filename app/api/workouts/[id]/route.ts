/**
 * `DELETE /api/workouts/[id]` — remove one of the signed-in user's workout definitions.
 *
 * The delete is scoped in the query itself (`deleteMany({ id, userId })`), so another
 * account's id simply matches nothing and is reported as absent (requirement 8.6). Recorded
 * sessions survive: `WorkoutSession.workoutId` is `onDelete: SetNull` and the session keeps
 * its own `workoutName`/`type` snapshot (requirements 5.9, 6.6).
 *
 * Requirements: 5.9, 6.6, 8.6, 8.7, 8.9
 */

import { NextResponse } from 'next/server'

import { resolveIdentity as resolveAuth } from '@/lib/identity'
import { databaseUnavailable, errorResponse, unauthorized } from '@/lib/data/apiResponses'
import { getPrismaClient } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  const auth = await resolveAuth()
  if (auth.kind === 'database-error') return databaseUnavailable('unreachable')
  if (auth.kind === 'anonymous') return unauthorized()

  const db = getPrismaClient()
  if (!db) return databaseUnavailable('not-configured')

  const id = params?.id
  if (typeof id !== 'string' || id.length === 0) {
    return NextResponse.json(
      { error: 'Validation failed', fields: { id: 'id is required' }, invalidFields: ['id'] },
      { status: 400 }
    )
  }

  try {
    const result = await db.workout.deleteMany({ where: { id, userId: auth.userId } })
    if (result.count === 0) {
      // Idempotent from the client's point of view: a repeated delete is not an error the
      // repository needs to retry, so it is reported plainly.
      return NextResponse.json({ error: 'Workout not found', deleted: false }, { status: 404 })
    }
    return NextResponse.json({ deleted: true, id })
  } catch (error) {
    return errorResponse(error)
  }
}
