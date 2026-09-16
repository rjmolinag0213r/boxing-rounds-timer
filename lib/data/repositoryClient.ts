'use client'

/**
 * The one repository instance the client components share.
 *
 * It starts in Local_Only_Mode, so the very first render never waits on the network. The
 * identity is discovered in the background from `/api/pair/identity`, which — unlike the
 * `/api/auth/session` probe this replaced — knows about **both** identity sources: an OAuth
 * session and a paired device cookie. The surrounding structure is unchanged: fire-and-forget,
 * tolerant of every failure, local-only on any doubt (requirements 8.1, 11.7, 12.10).
 *
 * The identity endpoint answers `200` even when there is no database, reporting
 * `syncAvailable: false`. That is the one deliberate deviation from the `503` convention, and
 * it is what lets this module tell "sync is not set up on this deployment" apart from "sync is
 * momentarily unreachable" — two states a bare `503` would conflate, and which the Sync panel
 * must word very differently (requirements 11.8, 13.2).
 *
 * When an identity *is* found, `setSession` triggers the existing reconcile that pushes this
 * device's local records and pulls the space's — the phone→computer fix (requirement 8.3). No
 * new merge logic is introduced here; pairing supplies an identity, nothing more.
 *
 * Requirements: 8.1, 8.3, 8.6, 8.11, 10.7, 11.7, 11.8, 11.9, 11.10, 11.11, 12.10
 */

import { createWorkoutRepository, type SyncingRepository } from './workoutRepository'

let repository: SyncingRepository | null = null
let sessionProbe: Promise<void> | null = null

/** `null` until the first probe settles: unknown is not the same answer as unavailable. */
let syncAvailable: boolean | null = null
const availabilityListeners = new Set<(available: boolean) => void>()

/**
 * Whether this deployment can sync at all.
 *
 * `null` means the probe has not settled yet, which the UI renders as "checking" rather than
 * as either extreme — showing "sync is off" for the half-second before the answer arrives
 * would be wrong on every deployment that *can* sync.
 */
export function getSyncAvailability(): boolean | null {
  return syncAvailable
}

/** Subscribes to availability changes. Returns the unsubscribe function. */
export function subscribeSyncAvailability(listener: (available: boolean) => void): () => void {
  availabilityListeners.add(listener)
  return () => {
    availabilityListeners.delete(listener)
  }
}

/** Records availability and notifies subscribers, but only on an actual change. */
function setSyncAvailability(available: boolean): void {
  if (syncAvailable === available) return
  syncAvailable = available
  for (const listener of availabilityListeners) listener(available)
}

/**
 * Reads the identity (OAuth or paired) from the pairing API, tolerating every failure.
 *
 * Every early return leaves the repository in Local_Only_Mode, which is a supported state: a
 * probe that cannot answer must never cost the user access to their own local records.
 */
async function probeSession(instance: SyncingRepository): Promise<void> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return
  try {
    const response = await fetch('/api/pair/identity', { headers: { accept: 'application/json' } })
    if (!response.ok) return

    const body = (await response.json()) as {
      kind?: unknown
      userId?: unknown
      syncAvailable?: unknown
    } | null

    // `syncAvailable: false` means this deployment has no DATABASE_URL. Supported, not broken:
    // stay local and let the Sync panel say so in one muted line (requirement 11.8).
    if (body?.syncAvailable === false) {
      setSyncAvailability(false)
      return
    }
    setSyncAvailability(true)

    const userId = body?.userId
    if (typeof userId === 'string' && userId.length > 0) {
      // The existing reconcile does all the work: pushes local records the space lacks, pulls
      // records this device has never seen, merges both directions (requirement 11.10).
      await instance.setSession(userId, body?.kind === 'oauth' ? 'oauth' : 'paired')
      return
    }

    // No identity: either never paired, or this device's `PairedDevice` row was revoked while
    // it was away. Both mean local-only, with every local record retained (requirement 10.7).
    await instance.setSession(null)
  } catch {
    // Offline, or a non-JSON answer: stay in Local_Only_Mode (requirement 11.11).
  }
}

/**
 * The shared repository. The first call also kicks off the (fire-and-forget) identity probe.
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

/** Resolves once the identity probe has settled. Exposed for callers that need to await it. */
export function whenSessionResolved(): Promise<void> {
  getWorkoutRepository()
  return sessionProbe ?? Promise.resolve()
}

/**
 * Re-runs the identity probe after a pair, unlink, or rotate.
 *
 * Each of those three changes the answer the endpoint would give — a new cookie, a revoked
 * cookie, a new space — so the memoised probe is dropped and re-run rather than trusted
 * (requirement 11.9). Reuses the same singleton discipline, so a concurrent caller awaiting
 * `whenSessionResolved()` awaits the fresh probe.
 */
export function refreshIdentity(): Promise<void> {
  const instance = getWorkoutRepository()
  sessionProbe = probeSession(instance)
  return sessionProbe
}

/** Test seam: drops the singleton, the probe, and the recorded availability. */
export function resetWorkoutRepositoryForTests(): void {
  repository = null
  sessionProbe = null
  syncAvailable = null
  availabilityListeners.clear()
}
