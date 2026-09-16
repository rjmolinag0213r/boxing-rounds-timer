/**
 * `GET /api/sessions` — the signed-in user's workout history, newest first.
 * `POST /api/sessions` — record one run, keyed by the client-generated id.
 *
 * Same contract as `/api/workouts`: idempotent upsert (8.5), `userId`-scoped reads and writes
 * (8.6), 401 without a session (8.7), 400 naming each invalid field (8.8), 503 when the
 * database is absent or unreachable (8.9). The extra rule here is requirement 6.5 — a
 * completed round count outside `[0, roundsPlanned]`, or a negative duration, is rejected with
 * the offending field named.
 *
 * A `workoutId` that does not resolve to one of the caller's own workouts is stored as `null`
 * rather than rejected: history is defined by its own `workoutName`/`type` snapshot
 * (requirement 6.4), so a session whose definition was never synced — or has since been
 * deleted — is still a perfectly valid record.
 *
 * Requirements: 6.1, 6.5, 8.5, 8.6, 8.7, 8.8, 8.9
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
import { validateSessionRequest } from '@/lib/data/apiSchemas'
import { toWorkoutSessionDTO } from '@/lib/data/prismaMappers'
import { getPrismaClient } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const auth = await resolveAuth()
  if (auth.kind === 'database-error') return databaseUnavailable('unreachable')
  if (auth.kind === 'anonymous') return unauthorized()

  const db = getPrismaClient()
  if (!db) return databaseUnavailable('not-configured')

  try {
    const rows = await db.workoutSession.findMany({
      where: { userId: auth.userId },
      orderBy: { endedAt: 'desc' },
    })
    return NextResponse.json({ sessions: rows.map(toWorkoutSessionDTO) })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = await resolveAuth()
  if (auth.kind === 'database-error') return databaseUnavailable('unreachable')
  if (auth.kind === 'anonymous') return unauthorized()

  const validation = validateSessionRequest(await readJsonBody(request))
  if (!validation.success) return badRequest(validation.fieldErrors)

  const db = getPrismaClient()
  if (!db) return databaseUnavailable('not-configured')

  const session = validation.data

  try {
    const existing = await db.workoutSession.findUnique({ where: { id: session.id } })
    if (existing && existing.userId !== auth.userId) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    // Keep the foreign key satisfiable: only link a workout this user actually owns.
    let workoutId: string | null = null
    if (session.workoutId) {
      const workout = await db.workout.findFirst({
        where: { id: session.workoutId, userId: auth.userId },
        select: { id: true },
      })
      workoutId = workout?.id ?? null
    }

    const row = await db.workoutSession.upsert({
      where: { id: session.id },
      create: {
        id: session.id,
        userId: auth.userId,
        workoutId,
        workoutName: session.workoutName,
        type: session.type,
        roundsPlanned: session.roundsPlanned,
        roundsCompleted: session.roundsCompleted,
        totalDurationMs: session.totalDurationMs,
        completed: session.completed,
        startedAt: new Date(session.startedAt),
        endedAt: new Date(session.endedAt),
      },
      update: {
        workoutId,
        workoutName: session.workoutName,
        type: session.type,
        roundsPlanned: session.roundsPlanned,
        roundsCompleted: session.roundsCompleted,
        totalDurationMs: session.totalDurationMs,
        completed: session.completed,
        startedAt: new Date(session.startedAt),
        endedAt: new Date(session.endedAt),
      },
    })

    return NextResponse.json(
      { session: toWorkoutSessionDTO(row) },
      { status: existing ? 200 : 201 }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
