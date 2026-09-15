/**
 * The next-auth route handler for optional accounts.
 *
 * Nothing here runs at build time: {@link buildAuthOptions} reads the environment on first
 * request, so a deployment with no `DATABASE_URL` (or no OAuth provider) builds and boots
 * normally and simply answers 503 to any sign-in attempt — the client stays in
 * Local_Only_Mode (requirements 12.9, 12.10).
 *
 * Requirements: 8.6, 8.7, 12.9, 12.10
 */

import NextAuth from 'next-auth'
import { NextResponse } from 'next/server'

import { authAvailability, buildAuthOptions } from '@/lib/auth'

/** Explains why sign-in is unavailable, naming any missing configuration. */
function unavailable(): NextResponse {
  const availability = authAvailability()

  if (availability.status === 'misconfigured') {
    return NextResponse.json(
      {
        error: 'Accounts are enabled but not fully configured.',
        missing: availability.missing,
      },
      { status: 503 }
    )
  }

  return NextResponse.json(
    {
      error: 'Accounts are not enabled on this deployment. Workouts stay in this browser.',
      reason: availability.status === 'disabled' ? availability.reason : 'unknown',
    },
    { status: 503 }
  )
}

async function handler(request: Request, context: unknown): Promise<Response> {
  const options = buildAuthOptions()
  if (!options) return unavailable()

  // next-auth's App Router handler is created per request here rather than at module scope,
  // so importing this route never touches the database or the environment.
  const authHandler = NextAuth(options)
  return authHandler(request as never, context as never) as Promise<Response>
}

export { handler as GET, handler as POST }
