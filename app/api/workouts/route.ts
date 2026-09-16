/**
 * `GET /api/workouts` — the signed-in user's workout definitions.
 * `POST /api/workouts` — create or update one, keyed by the client-generated id.
 *
 * The POST is an **upsert on the client's id**, which is what makes a retry safe: the
 * repository re-sends a record whenever an earlier attempt failed, and the server still ends
 * up with exactly one row per identifier (requirement 8.5).
 *
 * Every query filters on the authenticated `userId`, and an id that exists but belongs to
 * someone else is reported as absent rather than overwritten (requirement 8.6).
 *
 * Requirements: 8.5, 8.6, 8.7, 8.8, 8.9
 */

import { NextResponse } from 'next/server'

import { resolveIdentity as resolveAuth } from '@/lib/identity'
import {
  badRequest,
  databaseUnavailable,
  errorResponse,
  readJsonBody,
  unauthorized,
} from '@/lib/data/apiResponses'
import { validateWorkoutRequest } from '@/lib/data/apiSchemas'
import { toWorkoutDTO } from '@/lib/data/prismaMappers'
import { getPrismaClient } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const auth = await resolveAuth()
  if (auth.kind === 'database-error') return databaseUnavailable('unreachable')
  if (auth.kind === 'anonymous') return unauthorized()

  const db = getPrismaClient()
  if (!db) return databaseUnavailable('not-configured')

  try {
    const rows = await db.workout.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({ workouts: rows.map(toWorkoutDTO) })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = await resolveAuth()
  if (auth.kind === 'database-error') return databaseUnavailable('unreachable')
  if (auth.kind === 'anonymous') return unauthorized()

  const validation = validateWorkoutRequest(await readJsonBody(request))
  if (!validation.success) return badRequest(validation.fieldErrors)

  const db = getPrismaClient()
  if (!db) return databaseUnavailable('not-configured')

  const workout = validation.data
  const createdAt = workout.createdAt !== undefined ? new Date(workout.createdAt) : undefined

  try {
    // Ownership check before the upsert: without it, a known id would let one account
    // overwrite another account's row (requirement 8.6).
    const existing = await db.workout.findUnique({ where: { id: workout.id } })
    if (existing && existing.userId !== auth.userId) {
      return NextResponse.json({ error: 'Workout not found' }, { status: 404 })
    }

    const row = await db.workout.upsert({
      where: { id: workout.id },
      create: {
        id: workout.id,
        userId: auth.userId,
        name: workout.name,
        type: workout.type,
        rounds: workout.rounds,
        roundSeconds: workout.roundSeconds,
        restSeconds: workout.restSeconds,
        prepSeconds: workout.prepSeconds,
        ...(createdAt ? { createdAt } : {}),
      },
      update: {
        name: workout.name,
        type: workout.type,
        rounds: workout.rounds,
        roundSeconds: workout.roundSeconds,
        restSeconds: workout.restSeconds,
        prepSeconds: workout.prepSeconds,
      },
    })

    return NextResponse.json({ workout: toWorkoutDTO(row) }, { status: existing ? 200 : 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
