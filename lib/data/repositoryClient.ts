'use client'

/**
 * The one repository instance the client components share.
 *
 * It starts in Local_Only_Mode, so the very first render never waits on the network. The
 * optional account is discovered in the background from next-auth's own
 * `/api/auth/session` endpoint; if accounts are disabled (no `DATABASE_URL`, no provider) that
 * request answers 503 and the app simply stays local — which is a supported mode, not a failure
 * (requirements 8.1, 12.10).
 *
 * When a user *is* signed in, `setSession` triggers the reconcile that pulls their workouts and
 * history onto this device — the phone→computer fix (requirement 8.3).
 *
 * Requirements: 8.1, 8.3, 8.11, 12.10
 */

import { createWorkoutRepository, type SyncingRepository } from './workoutRepository'

let repository: SyncingRepository | null = null
let sessionProbe: Promise<void> | null = null

/** Reads the optional account id from next-auth, quietly tolerating every failure. */
async function probeSession(instance: SyncingRepository): Promise<void> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return
  try {
    const response = await fetch('/api/auth/session', { headers: { accept: 'application/json' } })
    if (!response.ok) return
    const body = (await response.json()) as { user?: { id?: unknown } } | null
    const userId = body?.user?.id
    if (typeof userId === 'string' && userId.length > 0) {
      await instance.setSession(userId)
    }
  } catch {
    // Offline, accounts disabled, or a non-JSON answer: stay in Local_Only_Mode.
  }
}

/**
 * The shared repository. The first call also kicks off the (fire-and-forget) session probe.
 */
export function getWorkoutRepository(): SyncingRepository {
  if (!repository) {
    repository = createWorkoutRepository()
  }
  if (!sessionProbe) {
    sessionProbe = probeSession(repository)
  }
  return repository
}

/** Resolves once the session probe has settled. Exposed for callers that need to await it. */
export function whenSessionResolved(): Promise<void> {
  getWorkoutRepository()
  return sessionProbe ?? Promise.resolve()
}

/** Test seam: drops the singleton and the probe so each test starts clean. */
export function resetWorkoutRepositoryForTests(): void {
  repository = null
  sessionProbe = null
}
