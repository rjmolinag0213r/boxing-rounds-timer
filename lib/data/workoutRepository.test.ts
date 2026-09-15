/**
 * Unit tests for the hybrid repository.
 *
 * The interesting behavior is entirely in the *transitions* — no session to session, empty
 * device to hydrated device, server up to server down and back — so each test drives one
 * transition and asserts both sides of the mirror plus the sync state the UI renders from.
 *
 * Neither a browser nor a server is involved: workouts go to an injected array (standing in for
 * localStorage), history to the in-memory session persistence, and the remote is a fake whose
 * availability the test flips.
 *
 * Requirements: 6.5, 6.7, 8.1, 8.2, 8.3, 8.4, 8.10, 8.11
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { createMemorySessionPersistence } from '@/lib/data/sessionStore'
import {
  LocalWorkoutRepository,
  RemoteUnauthorizedError,
  RemoteUnavailableError,
  RemoteValidationError,
  SyncingRepository,
  createMemoryPendingStore,
  presetToWorkoutDTO,
  workoutDTOToPreset,
} from '@/lib/data/workoutRepository'
import type { Preset } from '@/lib/presets'
import type { WorkoutDTO, WorkoutSessionDTO } from '@/lib/types'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const preset = (id: string, overrides: Partial<Preset> = {}): Preset => ({
  id,
  name: `Workout ${id}`,
  type: 'BOXING',
  rounds: 3,
  roundSeconds: 180,
  restSeconds: 60,
  prepSeconds: 5,
  createdAt: 1_700_000_000_000,
  ...overrides,
})

const session = (id: string, overrides: Partial<WorkoutSessionDTO> = {}): WorkoutSessionDTO => ({
  id,
  workoutId: null,
  workoutName: `Workout for ${id}`,
  type: 'BOXING',
  roundsPlanned: 3,
  roundsCompleted: 3,
  totalDurationMs: 600_000,
  completed: true,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_600_000,
  ...overrides,
})

type RemoteMode = 'ok' | 'unavailable' | 'unauthorized' | 'invalid'

/** An in-memory stand-in for the API, with a switch for each failure the client must handle. */
function createFakeRemote(seed: { workouts?: Preset[]; sessions?: WorkoutSessionDTO[] } = {}) {
  const workouts = new Map<string, WorkoutDTO>(
    (seed.workouts ?? []).map((w) => [w.id, presetToWorkoutDTO(w)])
  )
  const sessions = new Map<string, WorkoutSessionDTO>((seed.sessions ?? []).map((s) => [s.id, s]))

  let mode: RemoteMode = 'ok'
  const calls = { listWorkouts: 0, listHistory: 0, saveWorkout: 0, recordSession: 0, deleteWorkout: 0 }
  /** What browser storage held at the moment each write reached the server. */
  const localAtWrite: string[][] = []

  const guard = (): void => {
    if (mode === 'unavailable') throw new RemoteUnavailableError('Server unavailable (503)', 503)
    if (mode === 'unauthorized') throw new RemoteUnauthorizedError()
    if (mode === 'invalid') throw new RemoteValidationError('Validation failed', { name: 'bad' })
  }

  return {
    calls,
    localAtWrite,
    workoutIds: () => [...workouts.keys()].sort(),
    sessionIds: () => [...sessions.keys()].sort(),
    workout: (id: string) => workouts.get(id),
    setMode: (next: RemoteMode) => {
      mode = next
    },
    async listWorkouts() {
      calls.listWorkouts += 1
      guard()
      return [...workouts.values()]
    },
    async listHistory() {
      calls.listHistory += 1
      guard()
      return [...sessions.values()]
    },
    async saveWorkout(workout: WorkoutDTO) {
      calls.saveWorkout += 1
      guard()
      workouts.set(workout.id, workout)
    },
    async deleteWorkout(id: string) {
      calls.deleteWorkout += 1
      guard()
      workouts.delete(id)
    },
    async recordSession(record: WorkoutSessionDTO) {
      calls.recordSession += 1
      guard()
      sessions.set(record.id, record)
    },
  }
}

interface Harness {
  repository: SyncingRepository
  local: LocalWorkoutRepository
  remote: ReturnType<typeof createFakeRemote>
  localWorkoutIds: () => string[]
}

function createHarness(
  seed: {
    localWorkouts?: Preset[]
    localSessions?: WorkoutSessionDTO[]
    remoteWorkouts?: Preset[]
    remoteSessions?: WorkoutSessionDTO[]
  } = {}
): Harness {
  let stored: Preset[] = [...(seed.localWorkouts ?? [])]

  const local = new LocalWorkoutRepository({
    persistence: createMemorySessionPersistence(seed.localSessions ?? []),
    readWorkouts: () => [...stored],
    writeWorkouts: (next) => {
      stored = [...next]
    },
  })

  const remote = createFakeRemote({
    workouts: seed.remoteWorkouts,
    sessions: seed.remoteSessions,
  })

  const repository = new SyncingRepository({
    local,
    remote,
    pending: createMemoryPendingStore(),
  })

  return { repository, local, remote, localWorkoutIds: () => stored.map((w) => w.id).sort() }
}

/* -------------------------------------------------------------------------- */
/* Local_Only_Mode (requirements 8.1, 12.10)                                   */
/* -------------------------------------------------------------------------- */

describe('Local_Only_Mode', () => {
  it('reads and writes browser storage only, and never calls the API', async () => {
    const { repository, remote, localWorkoutIds } = createHarness()

    await repository.saveWorkout(preset('w-1'))
    await repository.recordSession(session('s-1'))

    expect(localWorkoutIds()).toEqual(['w-1'])
    expect(await repository.listWorkouts()).toHaveLength(1)
    expect(await repository.listHistory()).toHaveLength(1)
    expect(remote.calls).toMatchObject({ saveWorkout: 0, recordSession: 0, listWorkouts: 0 })
  })

  it('reports itself as synchronized — there is nothing to sync', async () => {
    const { repository } = createHarness()

    await repository.saveWorkout(preset('w-1'))

    expect(repository.getState()).toMatchObject({
      mode: 'local-only',
      userId: null,
      synchronized: true,
      pendingCount: 0,
    })
  })

  it('deletes locally without reaching for the API', async () => {
    const { repository, remote, localWorkoutIds } = createHarness({ localWorkouts: [preset('w-1')] })

    await repository.deleteWorkout('w-1')

    expect(localWorkoutIds()).toEqual([])
    expect(remote.calls.deleteWorkout).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* First load on a new device (requirement 8.3) — the phone -> computer fix     */
/* -------------------------------------------------------------------------- */

describe('first load for an authenticated user with empty browser storage (requirement 8.3)', () => {
  it('fetches that user’s workouts and history from the server', async () => {
    const { repository, remote } = createHarness({
      remoteWorkouts: [preset('phone-workout')],
      remoteSessions: [session('phone-session')],
    })

    await repository.setSession('user-a')

    expect((await repository.listWorkouts()).map((w) => w.id)).toEqual(['phone-workout'])
    expect((await repository.listHistory()).map((s) => s.id)).toEqual(['phone-session'])
    // Nothing local was missing, so nothing was pushed back.
    expect(remote.calls.saveWorkout).toBe(0)
    expect(repository.getState()).toMatchObject({ mode: 'authenticated', synchronized: true })
  })

  it('makes the fetched workout usable as a Preset', async () => {
    const original = preset('phone-workout', { type: 'MMA', rounds: 5, roundSeconds: 300, prepSeconds: 10 })
    const { repository } = createHarness({ remoteWorkouts: [original] })

    await repository.setSession('user-a')
    const [fetched] = await repository.listWorkouts()

    expect(fetched).toEqual(workoutDTOToPreset(presetToWorkoutDTO(original)))
  })
})

/* -------------------------------------------------------------------------- */
/* Sign-in push (requirement 8.4)                                              */
/* -------------------------------------------------------------------------- */

describe('signing in on a device holding local-only records (requirement 8.4)', () => {
  it('pushes the records the server does not have and marks them synchronized', async () => {
    const { repository, remote } = createHarness({
      localWorkouts: [preset('local-only')],
      localSessions: [session('local-session')],
    })

    await repository.signIn('user-a')

    expect(remote.workoutIds()).toEqual(['local-only'])
    expect(remote.sessionIds()).toEqual(['local-session'])
    expect(repository.getState()).toMatchObject({ synchronized: true, pendingCount: 0 })
  })

  it('merges both directions, keeping local and server records side by side', async () => {
    const { repository, remote } = createHarness({
      localWorkouts: [preset('from-this-device')],
      remoteWorkouts: [preset('from-the-phone')],
      localSessions: [session('here')],
      remoteSessions: [session('there')],
    })

    await repository.signIn('user-a')

    expect((await repository.listWorkouts()).map((w) => w.id).sort()).toEqual([
      'from-the-phone',
      'from-this-device',
    ])
    expect((await repository.listHistory()).map((s) => s.id).sort()).toEqual(['here', 'there'])
    expect(remote.workoutIds()).toEqual(['from-the-phone', 'from-this-device'])
  })

  it('does not re-push a record the server already has', async () => {
    const shared = preset('shared')
    const { repository, remote } = createHarness({
      localWorkouts: [shared],
      remoteWorkouts: [shared],
    })

    await repository.signIn('user-a')

    expect(remote.calls.saveWorkout).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Local-first mirroring (requirement 8.2)                                     */
/* -------------------------------------------------------------------------- */

describe('authenticated writes (requirement 8.2)', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = createHarness()
    await harness.repository.setSession('user-a')
  })

  it('writes browser storage first, then mirrors to the server', async () => {
    const { repository, remote, localWorkoutIds } = harness

    await repository.saveWorkout(preset('w-1'))

    expect(localWorkoutIds()).toEqual(['w-1'])
    expect(remote.workoutIds()).toEqual(['w-1'])
    expect(remote.calls.saveWorkout).toBe(1)
  })

  it('mirrors recorded sessions', async () => {
    const { repository, remote } = harness

    await repository.recordSession(session('s-1'))

    expect((await repository.listHistory()).map((s) => s.id)).toEqual(['s-1'])
    expect(remote.sessionIds()).toEqual(['s-1'])
  })

  it('mirrors deletions', async () => {
    const { repository, remote, localWorkoutIds } = harness

    await repository.saveWorkout(preset('w-1'))
    await repository.deleteWorkout('w-1')

    expect(localWorkoutIds()).toEqual([])
    expect(remote.workoutIds()).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* Server unavailable (requirements 6.7, 8.10)                                 */
/* -------------------------------------------------------------------------- */

describe('unreachable API or 503 (requirements 6.7, 8.10)', () => {
  it('keeps the record locally, flags it unsynchronized, and marks it pending', async () => {
    const harness = createHarness()
    await harness.repository.setSession('user-a')
    harness.remote.setMode('unavailable')

    // Resolves: from the user's point of view the workout was saved, because it was.
    await harness.repository.saveWorkout(preset('w-1'))

    expect(harness.localWorkoutIds()).toEqual(['w-1'])
    expect(await harness.repository.listWorkouts()).toHaveLength(1)
    expect(harness.repository.getState()).toMatchObject({
      mode: 'authenticated',
      synchronized: false,
      pendingCount: 1,
    })
    expect(harness.repository.getState().lastError).toMatch(/unavailable/i)
  })

  it('keeps a recorded session pending rather than losing it (requirement 6.7)', async () => {
    const harness = createHarness()
    await harness.repository.setSession('user-a')
    harness.remote.setMode('unavailable')

    await harness.repository.recordSession(session('s-1'))

    expect((await harness.repository.listHistory()).map((s) => s.id)).toEqual(['s-1'])
    expect(harness.repository.getState().pendingCount).toBe(1)
  })

  it('serves reads from browser storage when sign-in cannot reach the server', async () => {
    const harness = createHarness({
      localWorkouts: [preset('w-1')],
      localSessions: [session('s-1')],
    })
    harness.remote.setMode('unavailable')

    await harness.repository.setSession('user-a')

    expect((await harness.repository.listWorkouts()).map((w) => w.id)).toEqual(['w-1'])
    expect((await harness.repository.listHistory()).map((s) => s.id)).toEqual(['s-1'])
    // Everything local is owed to the server, so the next success pushes it.
    expect(harness.repository.getState()).toMatchObject({ synchronized: false, pendingCount: 2 })
  })

  it('retries pending records on the next successful request', async () => {
    const harness = createHarness()
    await harness.repository.setSession('user-a')

    harness.remote.setMode('unavailable')
    await harness.repository.saveWorkout(preset('w-1'))
    expect(harness.repository.getState().pendingCount).toBe(1)

    harness.remote.setMode('ok')
    // A later successful write is the trigger; the backlog rides along with it.
    await harness.repository.recordSession(session('s-1'))

    expect(harness.remote.workoutIds()).toEqual(['w-1'])
    expect(harness.remote.sessionIds()).toEqual(['s-1'])
    expect(harness.repository.getState()).toMatchObject({ synchronized: true, pendingCount: 0 })
  })

  it('replays a pending deletion instead of resurrecting the workout on the next sync', async () => {
    const harness = createHarness({
      localWorkouts: [preset('w-1')],
      remoteWorkouts: [preset('w-1')],
    })
    await harness.repository.setSession('user-a')

    harness.remote.setMode('unavailable')
    await harness.repository.deleteWorkout('w-1')
    expect(harness.localWorkoutIds()).toEqual([])

    harness.remote.setMode('ok')
    await harness.repository.setSession('user-a')

    expect(harness.localWorkoutIds()).toEqual([])
    expect(harness.remote.workoutIds()).toEqual([])
    expect(harness.repository.getState()).toMatchObject({ synchronized: true })
  })

  it('notifies subscribers when the sync state changes', async () => {
    const harness = createHarness()
    await harness.repository.setSession('user-a')

    const seen: boolean[] = []
    harness.repository.subscribe((state) => seen.push(state.synchronized))

    harness.remote.setMode('unavailable')
    await harness.repository.saveWorkout(preset('w-1'))

    expect(seen).toContain(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Non-retryable failures (requirements 6.5, 8.7)                              */
/* -------------------------------------------------------------------------- */

describe('non-retryable failures', () => {
  it('reports a validation rejection to the caller and keeps the local record (requirement 6.5)', async () => {
    const harness = createHarness()
    await harness.repository.setSession('user-a')
    harness.remote.setMode('invalid')

    await expect(harness.repository.recordSession(session('s-1'))).rejects.toBeInstanceOf(
      RemoteValidationError
    )

    expect((await harness.repository.listHistory()).map((s) => s.id)).toEqual(['s-1'])
    // A body the server will always reject is not retried forever.
    expect(harness.repository.getState().pendingCount).toBe(0)
  })

  it('returns to Local_Only_Mode when the server reports no session (requirement 8.7)', async () => {
    const harness = createHarness()
    await harness.repository.setSession('user-a')
    harness.remote.setMode('unauthorized')

    await harness.repository.saveWorkout(preset('w-1'))

    expect(harness.repository.getState()).toMatchObject({ mode: 'local-only', userId: null })
    expect(harness.localWorkoutIds()).toEqual(['w-1'])
  })
})

/* -------------------------------------------------------------------------- */
/* Sign-out (requirement 8.11)                                                 */
/* -------------------------------------------------------------------------- */

describe('signing out (requirement 8.11)', () => {
  it('returns to Local_Only_Mode and serves subsequent reads from browser storage', async () => {
    const harness = createHarness({ remoteWorkouts: [preset('synced')] })
    await harness.repository.setSession('user-a')
    expect((await harness.repository.listWorkouts()).map((w) => w.id)).toEqual(['synced'])

    await harness.repository.signOut()

    const callsBefore = { ...harness.remote.calls }
    await harness.repository.saveWorkout(preset('after-signout'))
    await harness.repository.recordSession(session('after-signout'))

    expect(harness.repository.getState()).toMatchObject({
      mode: 'local-only',
      userId: null,
      synchronized: true,
    })
    expect(harness.remote.calls).toEqual(callsBefore)
    expect(harness.localWorkoutIds()).toEqual(['after-signout', 'synced'])
  })

  it('clears the unsynchronized indicator, since Local_Only_Mode owes the server nothing', async () => {
    const harness = createHarness()
    await harness.repository.setSession('user-a')
    harness.remote.setMode('unavailable')
    await harness.repository.saveWorkout(preset('w-1'))
    expect(harness.repository.getState().synchronized).toBe(false)

    await harness.repository.signOut()

    expect(harness.repository.getState()).toMatchObject({ synchronized: true, pendingCount: 0 })

    // Signing back in re-pushes whatever the server still lacks, so nothing was lost.
    harness.remote.setMode('ok')
    await harness.repository.signIn('user-a')
    expect(harness.remote.workoutIds()).toEqual(['w-1'])
  })
})
