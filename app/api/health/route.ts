/**
 * `GET /api/health` — the readiness probe Railway's healthcheck hits.
 *
 * It answers 200 as soon as the server can serve requests and **never touches the database**
 * (requirement 12.11). That is the whole point: the timer works with no database at all
 * (Local_Only_Mode, requirement 12.10), so failing the healthcheck on a database hiccup would
 * take a perfectly functional app out of rotation. The database's state is *reported* in the
 * body for operators, not used as a gate.
 *
 * Requirements: 12.10, 12.11
 */

import { NextResponse } from 'next/server'

import { authAvailability } from '@/lib/auth'
import { databaseConfigured } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return NextResponse.json(
    {
      status: 'ok',
      // Informational only — a 'not-configured' database still returns 200.
      database: databaseConfigured() ? 'configured' : 'not-configured',
      accounts: authAvailability().status,
      mode: databaseConfigured() ? 'sync-capable' : 'local-only',
      timestamp: new Date().toISOString(),
    },
    { status: 200 }
  )
}
