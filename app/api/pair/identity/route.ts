/**
 * `GET /api/pair/identity` — who am I, and is sync even possible on this deployment?
 *
 * **This route answers `200` always, and that is a deliberate, documented deviation from the
 * `503` convention every other pairing route follows.** It is a capability-discovery endpoint,
 * not a data endpoint, and the client has to tell apart three states a bare `503` conflates:
 *
 * - sync is *not configured here* — hide the pairing controls and say why;
 * - sync is available and this device is *not paired* — offer to pair;
 * - sync is available but *momentarily unreachable* — offer a retry.
 *
 * Collapsing the first two into `503` would make a correctly working local-only deployment show
 * an error. The response carries no secret and has no side effect, so answering `200` leaks
 * nothing. It also keeps the existing `if (!response.ok) return` guard in `repositoryClient.ts`
 * correct by construction.
 *
 * Requirements: 11.7, 11.8, 13.2
 */

import { NextResponse } from 'next/server'

import { resolveIdentity } from '@/lib/identity'
import { getPrismaClient } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** The shape the repository client's probe reads. `kind` mirrors the identity's source. */
interface IdentityResponseBody {
  kind: 'anonymous' | 'paired' | 'oauth'
  userId: string | null
  deviceId: string | null
  syncAvailable: boolean
}

const localOnly: IdentityResponseBody = {
  kind: 'anonymous',
  userId: null,
  deviceId: null,
  syncAvailable: false,
}

export async function GET(): Promise<Response> {
  // No database configured: the exact body requirement 13.2 specifies, at status 200.
  if (!getPrismaClient()) return NextResponse.json(localOnly)

  const identity = await resolveIdentity()

  if (identity.kind === 'database-error') {
    // Configured but unreachable. Still `200`, still `syncAvailable: false` — with one extra
    // field, so a client that cares can distinguish this from "not configured" and offer a
    // retry rather than an explanation.
    return NextResponse.json({ ...localOnly, reason: 'unreachable' })
  }

  if (identity.kind === 'anonymous') {
    return NextResponse.json({ ...localOnly, syncAvailable: true })
  }

  return NextResponse.json({
    kind: identity.source === 'oauth' ? 'oauth' : 'paired',
    userId: identity.userId,
    deviceId: identity.deviceId ?? null,
    syncAvailable: true,
  })
}
