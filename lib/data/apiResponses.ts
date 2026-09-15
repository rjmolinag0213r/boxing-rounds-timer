/**
 * The response vocabulary shared by every data route handler.
 *
 * The four outcomes the repository's sync logic branches on are fixed by requirement 8:
 * 401 without a session (8.7), 400 naming each invalid field (8.8), 503 when `DATABASE_URL`
 * is unset or the database is unreachable (8.9), and 200 with the record otherwise. They
 * live here so `/api/workouts` and `/api/sessions` cannot drift apart — the client treats a
 * 503 from either as "keep serving from browser storage" (requirement 8.10).
 *
 * Requirements: 8.7, 8.8, 8.9
 */

import { NextResponse } from 'next/server'

import type { FieldErrors } from './apiSchemas'

/** Prisma initialization/connectivity error codes: unreachable, timed out, TLS, auth. */
const UNREACHABLE_PRISMA_CODES = new Set(['P1000', 'P1001', 'P1002', 'P1003', 'P1008', 'P1010', 'P1011', 'P1017'])

/** 401 — the request carries no authenticated session (requirement 8.7). */
export function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: 'Authentication required. Sign in to sync workouts and history across devices.' },
    { status: 401 }
  )
}

/** 400 — the body failed schema validation; every invalid field is named (requirement 8.8). */
export function badRequest(fields: FieldErrors): NextResponse {
  return NextResponse.json(
    { error: 'Validation failed', fields, invalidFields: Object.keys(fields) },
    { status: 400 }
  )
}

/**
 * 503 — no database is configured, or it is unreachable (requirement 8.9).
 *
 * The client reads this as "stay in browser storage and retry later", so the body carries a
 * machine-readable `reason` rather than only prose.
 */
export function databaseUnavailable(
  reason: 'not-configured' | 'unreachable' = 'not-configured'
): NextResponse {
  return NextResponse.json(
    {
      error:
        reason === 'not-configured'
          ? 'Server-side sync is not configured. Your data stays in this browser.'
          : 'The database is unreachable. Your data stays in this browser and will sync later.',
      reason,
    },
    { status: 503 }
  )
}

/** 500 — an unexpected server-side failure that is not a connectivity problem. */
export function serverError(): NextResponse {
  return NextResponse.json({ error: 'Unexpected server error' }, { status: 500 })
}

/**
 * `true` when the error means "the database could not be reached", as opposed to a query or
 * constraint error. Prisma reports the former as `PrismaClientInitializationError` or a
 * `P10xx` code; anything else is a genuine bug and must not be masked as a 503.
 */
export function isDatabaseUnreachable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown }

  if (candidate.name === 'PrismaClientInitializationError') return true
  if (typeof candidate.code === 'string' && UNREACHABLE_PRISMA_CODES.has(candidate.code)) return true
  if (candidate.code === 'ECONNREFUSED' || candidate.code === 'ENOTFOUND') return true

  return (
    typeof candidate.message === 'string' &&
    /can't reach database server|connection refused|environment variable not found: database_url/i.test(
      candidate.message
    )
  )
}

/** Maps a thrown error onto the 503-or-500 split above. */
export function errorResponse(error: unknown): NextResponse {
  return isDatabaseUnreachable(error) ? databaseUnavailable('unreachable') : serverError()
}

/** Parses a JSON request body, returning `undefined` for an absent or malformed one. */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}
