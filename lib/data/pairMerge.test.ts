// @vitest-environment node

/**
 * The pair-and-merge seam.
 *
 * This is the one test that exercises the whole promise pairing makes — "both devices end up
 * holding everything" — end to end at the seam, rather than one module at a time. Two
 * `SyncingRepository` instances, each with its own browser storage, talk over
 * `RemoteWorkoutRepository` to the **real** `/api/workouts` and `/api/sessions` handlers, which
 * in turn read and write the in-memory Prisma fake. Only two boundaries are replaced: the
 * identity resolver (so each request can be attributed to a device) and the Prisma client.
 *
 * Nothing about the merge is re-implemented here, which is the point: pairing supplies an
 * identity and the existing reconcile does the work. If this passes and Property 15 passes, the
 * feature's data promise holds.
 *
 * Node environment rather than jsdom: `next/server` needs the platform `Request`/`Response`.
 *
 * Requirements: 9.4, 9.5
 */

import fc from 'fast-check'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createPrismaFake, type PrismaFake } from '@/lib/pairing/__fixtures__/prismaFake'
import { createMemorySessionPersistence } from '@/lib/data/sessionStore'
import {
  LocalWorkoutRepository,
  RemoteWorkoutRepository,
  SyncingRepository,
  createMemoryPendingStore,
} from '@/lib/data/workoutRepository'
import type { Preset } from '@/lib/presets'
import type { WorkoutSessionDTO } from '@/lib/types'

vi.mock('@/lib/identity', () => ({
  resolveIdentity: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getPrismaClient: vi.fn(),
  databaseConfigured: vi.fn(() => true),
}))

const { resolveIdentity } = await import('@/lib/identity')
const { getPrismaClient } = await import('@/lib/db')
const workoutsRoute = await import('@/app/api/workouts/route')
const workoutIdRoute = await import('@/app/api/workouts/[id]/route')
const sessionsRoute = await import('@/app/api/sessions/route')

/* -------------------------------------------------------------------------- */
/* Generators                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A small shared id pool, so `A` and `B` overlap often.
 *
 * Disjoint sets would only ever exercise the easy half of the union: the interesting case is a
 * client-generated id present on both sides, where the merge has to pick one copy rather than
 * keep two.
 */
const idPool = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'] as const
const sessionIdPool = ['s1', 's2', 's3', 's4', 's5', 's6'] as const

const presetArb = (id: string, tag: string): fc.Arbitrary<Preset> =>
  fc.record({
    rounds: fc.integer({ min: 1, max: 20 }),
    roundSeconds: fc.integer({ min: 1, max: 600 }),
    restSeconds: fc.integer({ min: 0, max: 300 }),
    prepSeconds: fc.integer({ min: 0, max: 60 }),
    createdAt: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
  }).map((fields) => ({
    id,
    // The name carries the origin, so a failing counterexample says which side's copy survived.
    name: `${tag}-${id}`,
    type: 'BOXING' as const,
    ...fields,
  }))

const sessionArb = (id: string, tag: string): fc.Arbitrary<WorkoutSessionDTO> =>
  fc.record({
    roundsPlanned: fc.integer({ min: 1, max: 20 }),
    totalDurationMs: fc.integer({ min: 0, max: 10_000_000 }),
    completed: fc.boolean(),
    startedAt: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
  }).map((fields) => ({
    id,
    workoutId: null,
    workoutName: `${tag}-${id}`,
    type: 'BOXING' as const,
    roundsPlanned: fields.roundsPlanned,
    // Kept inside `[0, roundsPlanned]` so the body is always valid: this property is about the
    // merge, and a 400 would test the schema instead.
    roundsCompleted: fields.roundsPlanned,
    totalDurationMs: fields.totalDurationMs,
    completed: fields.completed,
    startedAt: fields.startedAt,
    endedAt: fields.startedAt + fields.totalDurationMs,
  }))

/** A device's whole local library: some subset of the id pool, each row freshly generated. */
const librarySetArb = (tag: string) =>
  fc.record({
    workouts: fc
      .subarray([...idPool])
      .chain((ids) => fc.tuple(...ids.map((id) => presetArb(id, tag)))),
    sessions: fc
      .subarray([...sessionIdPool])
      .chain((ids) => fc.tuple(...ids.map((id) => sessionArb(id, tag)))),
  })

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

interface Device {
  repository: SyncingRepository
  workoutIds: () => string[]
  sessionIds: () => Promise<string[]>
}

/**
 * One device: browser storage in front, the real route handlers behind.
 *
 * `fetchImpl` re-asserts this device's identity immediately before dispatching, which is what
 * lets two devices share one mocked resolver while each request is still attributed correctly.
 * Requests are awaited one at a time, so there is no interleaving to confuse.
 */
function createDevice(userId: string, deviceId: string, seed: {
  workouts: Preset[]
  sessions: WorkoutSessionDTO[]
}): Device {
  let stored: Preset[] = [...seed.workouts]

  const local = new LocalWorkoutRepository({
    persistence: createMemorySessionPersistence(seed.sessions),
    readWorkouts: () => [...stored],
    writeWorkouts: (next) => {
      stored = [...next]
    },
  })

  const fetchImpl: typeof fetch = async (input, init) => {
    vi.mocked(resolveIdentity).mockResolvedValue({
      kind: 'authenticated',
      userId,
      source: 'paired',
      deviceId,
    })

    const url = typeof input === 'string' ? input : String(input)
    const path = new URL(url, 'http://localhost').pathname
    const request = new Request(`http://localhost${path}`, init as RequestInit)

    if (path === '/api/workouts') {
      return init?.method === 'POST' ? workoutsRoute.POST(request) : workoutsRoute.GET()
    }
    if (path.startsWith('/api/workouts/')) {
      const id = decodeURIComponent(path.slice('/api/workouts/'.length))
      return workoutIdRoute.DELETE(request, { params: { id } })
    }
    if (path === '/api/sessions') {
      return init?.method === 'POST' ? sessionsRoute.POST(request) : sessionsRoute.GET()
    }
    throw new Error(`pairMerge: unrouted path ${path}`)
  }

  const repository = new SyncingRepository({
    local,
    remote: new RemoteWorkoutRepository({ fetchImpl }),
    pending: createMemoryPendingStore(),
  })

  return {
    repository,
    workoutIds: () => stored.map((w) => w.id).sort(),
    sessionIds: async () => (await local.listHistory()).map((s) => s.id).sort(),
  }
}

let fake: PrismaFake

const useFake = (): void => {
  fake = createPrismaFake()
  vi.mocked(getPrismaClient).mockReturnValue(fake as never)
}

const serverWorkoutIds = (userId: string): string[] =>
  fake.store.workouts
    .filter((w) => w.userId === userId)
    .map((w) => w.id)
    .sort()

const serverSessionIds = (userId: string): string[] =>
  fake.store.workoutSessions
    .filter((s) => s.userId === userId)
    .map((s) => s.id)
    .sort()

const union = (left: string[], right: string[]): string[] =>
  [...new Set([...left, ...right])].sort()

/* -------------------------------------------------------------------------- */
/* Property 14                                                                 */
/* -------------------------------------------------------------------------- */

describe('Property 14: Pairing merges to the union, idempotently', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('leaves both devices and the sync space holding exactly A ∪ B, keyed by id', async () => {
    // **Validates: Requirements 9.4, 9.5**
    await fc.assert(
      fc.asyncProperty(librarySetArb('A'), librarySetArb('B'), async (setA, setB) => {
        useFake()

        // One space, two devices — exactly what a claim produces: both devices resolve to the
        // same `userId`, which is the whole of what pairing contributes.
        const userId = 'usr_space'
        const deviceA = createDevice(userId, 'dev_a', {
          workouts: [...setA.workouts],
          sessions: [...setA.sessions],
        })
        const deviceB = createDevice(userId, 'dev_b', {
          workouts: [...setB.workouts],
          sessions: [...setB.sessions],
        })

        const expectedWorkouts = union(
          setA.workouts.map((w) => w.id),
          setB.workouts.map((w) => w.id)
        )
        const expectedSessions = union(
          setA.sessions.map((s) => s.id),
          setB.sessions.map((s) => s.id)
        )

        // A pairs first and uploads its library; B then joins and pulls A's while pushing its
        // own; A's next reconcile pulls what B contributed. Three reconciles is the minimum
        // for both sides to see everything, and is exactly what the probe does in practice.
        await deviceA.repository.setSession(userId, 'paired')
        await deviceB.repository.setSession(userId, 'paired')
        await deviceA.repository.setSession(userId, 'paired')

        expect(deviceA.workoutIds()).toEqual(expectedWorkouts)
        expect(deviceB.workoutIds()).toEqual(expectedWorkouts)
        expect(await deviceA.sessionIds()).toEqual(expectedSessions)
        expect(await deviceB.sessionIds()).toEqual(expectedSessions)
        expect(serverWorkoutIds(userId)).toEqual(expectedWorkouts)
        expect(serverSessionIds(userId)).toEqual(expectedSessions)

        // Idempotence: further reconciles are a no-op. Guaranteed by the upsert on the
        // client-generated id — a re-push cannot duplicate a row.
        for (let round = 0; round < 3; round += 1) {
          await deviceA.repository.setSession(userId, 'paired')
          await deviceB.repository.setSession(userId, 'paired')
        }

        expect(deviceA.workoutIds()).toEqual(expectedWorkouts)
        expect(deviceB.workoutIds()).toEqual(expectedWorkouts)
        expect(await deviceA.sessionIds()).toEqual(expectedSessions)
        expect(await deviceB.sessionIds()).toEqual(expectedSessions)
        expect(serverWorkoutIds(userId)).toEqual(expectedWorkouts)
        expect(serverSessionIds(userId)).toEqual(expectedSessions)
      }),
      { numRuns: 25 }
    )
  })

  it('keeps a second sync space untouched by the merge', async () => {
    // The union is taken *within* a space. A record pushed by a paired device must not appear
    // in a stranger's space — the same invariant Property 15 states from the route's side.
    useFake()

    const paired = createDevice('usr_space', 'dev_a', {
      workouts: [
        {
          id: 'w1',
          name: 'A-w1',
          type: 'BOXING',
          rounds: 3,
          roundSeconds: 180,
          restSeconds: 60,
          prepSeconds: 5,
          createdAt: 1_700_000_000_000,
        },
      ],
      sessions: [],
    })
    const stranger = createDevice('usr_other', 'dev_c', { workouts: [], sessions: [] })

    await paired.repository.setSession('usr_space', 'paired')
    await stranger.repository.setSession('usr_other', 'paired')

    expect(stranger.workoutIds()).toEqual([])
    expect(serverWorkoutIds('usr_other')).toEqual([])
    expect(serverWorkoutIds('usr_space')).toEqual(['w1'])
  })
})
