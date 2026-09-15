// @vitest-environment node

/**
 * Integration tests for the data route handlers.
 *
 * The handlers are exercised as real functions against real `Request` objects; only the two
 * boundaries they cannot own are replaced — the session resolver and the Prisma client. That
 * keeps the tests honest about the things requirement 8 actually promises (status codes,
 * `userId` scoping, idempotency) without needing a database, and lets the 503 paths be provoked
 * deliberately: no `DATABASE_URL` (client is `null`) and an unreachable server (the client
 * throws `PrismaClientInitializationError`).
 *
 * Node environment rather than jsdom: `next/server` needs the platform `Request`/`Response`.
 *
 * Requirements: 6.5, 8.5, 8.6, 8.7, 8.8, 8.9, 12.11
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthResolution } from '@/lib/auth'

vi.mock('@/lib/auth', () => ({
  resolveAuth: vi.fn(),
  authAvailability: vi.fn(() => ({ status: 'disabled', reason: 'no-database' })),
}))

vi.mock('@/lib/db', () => ({
  getPrismaClient: vi.fn(),
  databaseConfigured: vi.fn(() => true),
}))

const { resolveAuth } = await import('@/lib/auth')
const { getPrismaClient } = await import('@/lib/db')
const workoutsRoute = await import('@/app/api/workouts/route')
const workoutIdRoute = await import('@/app/api/workouts/[id]/route')
const sessionsRoute = await import('@/app/api/sessions/route')
const healthRoute = await import('@/app/api/health/route')

/* -------------------------------------------------------------------------- */
/* Test doubles                                                                */
/* -------------------------------------------------------------------------- */

type Row = Record<string, any>

const matches = (row: Row, where: Row | undefined): boolean =>
  Object.entries(where ?? {}).every(([key, value]) => row[key] === value)

/** A minimal in-memory stand-in for one Prisma model delegate. */
function createTable(initial: Row[] = []) {
  let rows: Row[] = initial.map((row) => ({ ...row }))

  return {
    all: () => rows,
    findMany: async ({ where, orderBy }: any = {}) => {
      const found = rows.filter((row) => matches(row, where))
      if (!orderBy) return found
      const [key, direction] = Object.entries(orderBy)[0] as [string, string]
      return [...found].sort((a, b) => {
        const order = a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0
        return direction === 'desc' ? -order : order
      })
    },
    findUnique: async ({ where }: any) => rows.find((row) => matches(row, where)) ?? null,
    findFirst: async ({ where }: any) => rows.find((row) => matches(row, where)) ?? null,
    upsert: async ({ where, create, update }: any) => {
      const index = rows.findIndex((row) => matches(row, where))
      if (index >= 0) {
        rows[index] = { ...rows[index], ...update }
        return rows[index]
      }
      const row = { createdAt: new Date(), updatedAt: new Date(), ...create }
      rows.push(row)
      return row
    },
    deleteMany: async ({ where }: any) => {
      const before = rows.length
      rows = rows.filter((row) => !matches(row, where))
      return { count: before - rows.length }
    },
  }
}

function createFakePrisma(seed: { workouts?: Row[]; sessions?: Row[] } = {}) {
  return {
    workout: createTable(seed.workouts),
    workoutSession: createTable(seed.sessions),
  }
}

/** A client whose every query fails the way an unreachable database does. */
function createUnreachablePrisma() {
  const fail = () => {
    const error = new Error("Can't reach database server at `db:5432`")
    error.name = 'PrismaClientInitializationError'
    return Promise.reject(error)
  }
  const delegate = {
    findMany: fail,
    findUnique: fail,
    findFirst: fail,
    upsert: fail,
    deleteMany: fail,
  }
  return { workout: delegate, workoutSession: delegate }
}

const asAuthenticated = (userId: string): AuthResolution => ({ kind: 'authenticated', userId })

const useAuth = (resolution: AuthResolution): void => {
  vi.mocked(resolveAuth).mockResolvedValue(resolution)
}

const useDatabase = (client: unknown): void => {
  vi.mocked(getPrismaClient).mockReturnValue(client as never)
}

const postWorkout = (body: unknown): Request =>
  new Request('http://localhost/api/workouts', { method: 'POST', body: JSON.stringify(body) })

const postSession = (body: unknown): Request =>
  new Request('http://localhost/api/sessions', { method: 'POST', body: JSON.stringify(body) })

const validWorkout = (overrides: Row = {}): Row => ({
  id: 'w-1',
  name: 'Boxing — Classic 12×3',
  type: 'BOXING',
  rounds: 12,
  roundSeconds: 180,
  restSeconds: 60,
  prepSeconds: 5,
  createdAt: 1_700_000_000_000,
  ...overrides,
})

const validSession = (overrides: Row = {}): Row => ({
  id: 's-1',
  workoutId: null,
  workoutName: 'Boxing — Classic 12×3',
  type: 'BOXING',
  roundsPlanned: 12,
  roundsCompleted: 12,
  totalDurationMs: 2_880_000,
  completed: true,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_002_880_000,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
})

/* -------------------------------------------------------------------------- */
/* Authentication (requirement 8.7)                                            */
/* -------------------------------------------------------------------------- */

describe('no authenticated session (requirement 8.7)', () => {
  beforeEach(() => {
    useAuth({ kind: 'anonymous' })
    useDatabase(createFakePrisma())
  })

  it('answers 401 to every workouts and sessions request', async () => {
    const responses = await Promise.all([
      workoutsRoute.GET(),
      workoutsRoute.POST(postWorkout(validWorkout())),
      sessionsRoute.GET(),
      sessionsRoute.POST(postSession(validSession())),
      workoutIdRoute.DELETE(new Request('http://localhost/api/workouts/w-1', { method: 'DELETE' }), {
        params: { id: 'w-1' },
      }),
    ])

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401])
  })

  it('does not touch the database when unauthenticated', async () => {
    const db = createFakePrisma()
    useDatabase(db)
    const upsert = vi.spyOn(db.workout, 'upsert')

    await workoutsRoute.POST(postWorkout(validWorkout()))

    expect(upsert).not.toHaveBeenCalled()
  })
})

/* -------------------------------------------------------------------------- */
/* Scoping and idempotency (requirements 8.5, 8.6)                             */
/* -------------------------------------------------------------------------- */

describe('/api/workouts with a session', () => {
  it('returns only the caller’s workouts (requirement 8.6)', async () => {
    useAuth(asAuthenticated('user-a'))
    useDatabase(
      createFakePrisma({
        workouts: [
          { ...validWorkout({ id: 'mine' }), userId: 'user-a', createdAt: new Date(2) },
          { ...validWorkout({ id: 'theirs' }), userId: 'user-b', createdAt: new Date(1) },
          { ...validWorkout({ id: 'anonymous' }), userId: null, createdAt: new Date(3) },
        ],
      })
    )

    const response = await workoutsRoute.GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.workouts.map((w: Row) => w.id)).toEqual(['mine'])
  })

  it('stores exactly one row when the same id is sent twice (requirement 8.5)', async () => {
    useAuth(asAuthenticated('user-a'))
    const db = createFakePrisma()
    useDatabase(db)

    const first = await workoutsRoute.POST(postWorkout(validWorkout()))
    const second = await workoutsRoute.POST(postWorkout(validWorkout({ name: 'Renamed' })))

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(db.workout.all()).toHaveLength(1)
    expect(db.workout.all()[0]).toMatchObject({ id: 'w-1', name: 'Renamed', userId: 'user-a' })
  })

  it('attaches the caller’s userId to a created row (requirement 8.6)', async () => {
    useAuth(asAuthenticated('user-a'))
    const db = createFakePrisma()
    useDatabase(db)

    await workoutsRoute.POST(postWorkout(validWorkout()))

    expect(db.workout.all()[0].userId).toBe('user-a')
  })

  it('refuses to overwrite another user’s row with the same id (requirement 8.6)', async () => {
    useAuth(asAuthenticated('user-a'))
    const db = createFakePrisma({
      workouts: [{ ...validWorkout({ id: 'w-1', name: 'Theirs' }), userId: 'user-b' }],
    })
    useDatabase(db)

    const response = await workoutsRoute.POST(postWorkout(validWorkout({ name: 'Mine' })))

    expect(response.status).toBe(404)
    expect(db.workout.all()[0].name).toBe('Theirs')
  })
})

describe('DELETE /api/workouts/[id]', () => {
  const deleteRequest = (id: string): [Request, { params: { id: string } }] => [
    new Request(`http://localhost/api/workouts/${id}`, { method: 'DELETE' }),
    { params: { id } },
  ]

  it('deletes the caller’s workout and leaves recorded sessions alone (requirements 5.9, 6.6)', async () => {
    useAuth(asAuthenticated('user-a'))
    const db = createFakePrisma({
      workouts: [{ ...validWorkout({ id: 'w-1' }), userId: 'user-a' }],
      sessions: [{ ...validSession({ id: 's-1', workoutId: 'w-1' }), userId: 'user-a' }],
    })
    useDatabase(db)

    const response = await workoutIdRoute.DELETE(...deleteRequest('w-1'))

    expect(response.status).toBe(200)
    expect(db.workout.all()).toHaveLength(0)
    expect(db.workoutSession.all()).toHaveLength(1)
  })

  it('reports another user’s workout as absent (requirement 8.6)', async () => {
    useAuth(asAuthenticated('user-a'))
    const db = createFakePrisma({
      workouts: [{ ...validWorkout({ id: 'w-1' }), userId: 'user-b' }],
    })
    useDatabase(db)

    const response = await workoutIdRoute.DELETE(...deleteRequest('w-1'))

    expect(response.status).toBe(404)
    expect(db.workout.all()).toHaveLength(1)
  })
})

describe('/api/sessions with a session', () => {
  it('returns only the caller’s history, newest first (requirements 7.1, 8.6)', async () => {
    useAuth(asAuthenticated('user-a'))
    useDatabase(
      createFakePrisma({
        sessions: [
          { ...validSession({ id: 'older' }), userId: 'user-a', endedAt: new Date(1_000) },
          { ...validSession({ id: 'newer' }), userId: 'user-a', endedAt: new Date(9_000) },
          { ...validSession({ id: 'theirs' }), userId: 'user-b', endedAt: new Date(5_000) },
        ],
      })
    )

    const response = await sessionsRoute.GET()
    const body = await response.json()

    expect(body.sessions.map((s: Row) => s.id)).toEqual(['newer', 'older'])
  })

  it('stores exactly one row when the same session is sent twice (requirement 8.5)', async () => {
    useAuth(asAuthenticated('user-a'))
    const db = createFakePrisma()
    useDatabase(db)

    const first = await sessionsRoute.POST(postSession(validSession()))
    const second = await sessionsRoute.POST(postSession(validSession()))

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(db.workoutSession.all()).toHaveLength(1)
  })

  it('drops a workoutId that is not one of the caller’s workouts (requirement 6.4)', async () => {
    useAuth(asAuthenticated('user-a'))
    const db = createFakePrisma({
      workouts: [{ ...validWorkout({ id: 'w-other' }), userId: 'user-b' }],
    })
    useDatabase(db)

    await sessionsRoute.POST(postSession(validSession({ workoutId: 'w-other' })))

    // The record survives with its own name/type snapshot; only the link is dropped.
    expect(db.workoutSession.all()[0]).toMatchObject({
      workoutId: null,
      workoutName: 'Boxing — Classic 12×3',
      type: 'BOXING',
    })
  })
})

/* -------------------------------------------------------------------------- */
/* Validation (requirements 6.5, 8.8)                                          */
/* -------------------------------------------------------------------------- */

describe('validation failures name every invalid field (requirement 8.8)', () => {
  beforeEach(() => {
    useAuth(asAuthenticated('user-a'))
    useDatabase(createFakePrisma())
  })

  it('rejects a workout with an empty name and out-of-range durations', async () => {
    const response = await workoutsRoute.POST(
      postWorkout(validWorkout({ name: '   ', rounds: 0, roundSeconds: 0, restSeconds: -1 }))
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(Object.keys(body.fields).sort()).toEqual(
      ['name', 'restSeconds', 'roundSeconds', 'rounds'].sort()
    )
    expect(body.fields.rounds).toMatch(/at least 1/)
  })

  it('rejects a name longer than 60 characters', async () => {
    const response = await workoutsRoute.POST(postWorkout(validWorkout({ name: 'x'.repeat(61) })))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.fields.name).toMatch(/60 characters or fewer/)
  })

  it('rejects a completed round count above roundsPlanned (requirement 6.5)', async () => {
    const response = await sessionsRoute.POST(
      postSession(validSession({ roundsPlanned: 3, roundsCompleted: 4 }))
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.fields.roundsCompleted).toMatch(/between 0 and roundsPlanned/)
  })

  it('rejects a negative completed round count and a negative duration (requirement 6.5)', async () => {
    const response = await sessionsRoute.POST(
      postSession(validSession({ roundsCompleted: -1, totalDurationMs: -5 }))
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.fields.roundsCompleted).toMatch(/at least 0/)
    expect(body.fields.totalDurationMs).toMatch(/at least 0/)
  })

  it('rejects a malformed body without a stack trace escaping', async () => {
    const response = await workoutsRoute.POST(
      new Request('http://localhost/api/workouts', { method: 'POST', body: 'not json' })
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.invalidFields.length).toBeGreaterThan(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Database availability (requirement 8.9)                                     */
/* -------------------------------------------------------------------------- */

describe('database unavailable (requirement 8.9)', () => {
  beforeEach(() => {
    useAuth(asAuthenticated('user-a'))
  })

  it('answers 503 when DATABASE_URL is unset', async () => {
    useDatabase(null)

    const responses = await Promise.all([
      workoutsRoute.GET(),
      workoutsRoute.POST(postWorkout(validWorkout())),
      sessionsRoute.GET(),
      sessionsRoute.POST(postSession(validSession())),
    ])

    expect(responses.map((r) => r.status)).toEqual([503, 503, 503, 503])
    expect((await responses[0].json()).reason).toBe('not-configured')
  })

  it('answers 503 when the database is unreachable', async () => {
    useDatabase(createUnreachablePrisma())

    const responses = await Promise.all([
      workoutsRoute.GET(),
      workoutsRoute.POST(postWorkout(validWorkout())),
      sessionsRoute.GET(),
      sessionsRoute.POST(postSession(validSession())),
    ])

    expect(responses.map((r) => r.status)).toEqual([503, 503, 503, 503])
    expect((await responses[1].json()).reason).toBe('unreachable')
  })

  it('answers 503 rather than 401 when the session store itself is unreachable', async () => {
    // Otherwise the client would conclude it had been signed out and stop syncing (8.10).
    useAuth({ kind: 'database-error', error: new Error('down') })
    useDatabase(createFakePrisma())

    const response = await workoutsRoute.GET()

    expect(response.status).toBe(503)
  })
})

/* -------------------------------------------------------------------------- */
/* Healthcheck (requirement 12.11)                                             */
/* -------------------------------------------------------------------------- */

describe('/api/health (requirement 12.11)', () => {
  it('answers 200 without any database access', async () => {
    // No Prisma client at all: a readiness probe must not depend on the database.
    useDatabase(null)

    const response = await healthRoute.GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(vi.mocked(getPrismaClient)).not.toHaveBeenCalled()
  })
})
