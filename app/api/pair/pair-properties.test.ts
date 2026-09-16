// @vitest-environment node

/**
 * The pairing routes' correctness properties: 8, 9, 15, and 21.
 *
 * The handlers run as real functions against real `Request` objects. Only three boundaries are
 * replaced — the OAuth session, the Prisma client (the shared in-memory fake), and the cookie
 * store — so the identity resolution, the atomic consumption, the rate-limit ledger, and the
 * response bodies under test are all the production code paths.
 *
 * Two of the fake's behaviours are load-bearing here and are the reason these properties are not
 * vacuous: `updateMany` honours its `WHERE` atomically (Property 8), and nothing is scoped
 * implicitly, so a handler that forgot `where: { userId }` would be visible (Property 15).
 *
 * Node environment rather than jsdom: `next/server` needs the platform `Request`/`Response`.
 *
 * Requirements: 3.1, 3.2, 3.3, 5.1, 5.2, 5.3, 10.9, 10.10, 10.11, 14.1, 14.2, 14.6
 */

import fc from 'fast-check'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createPrismaFake,
  type FakeStore,
  type PrismaFake,
} from '@/lib/pairing/__fixtures__/prismaFake'

/* -------------------------------------------------------------------------- */
/* Boundaries                                                                  */
/* -------------------------------------------------------------------------- */

const holder = vi.hoisted(() => ({
  client: null as unknown,
  cookie: null as string | null,
}))

vi.mock('@/lib/auth', () => ({ resolveAuth: vi.fn(async () => ({ kind: 'anonymous' })) }))

vi.mock('@/lib/db', () => ({
  getPrismaClient: () => holder.client,
  databaseConfigured: () => holder.client !== null,
}))

vi.mock('next/headers', () => ({
  cookies: () => ({
    get: (name: string) =>
      name === 'bx_device' && holder.cookie !== null ? { name, value: holder.cookie } : undefined,
  }),
}))

const { hashCode, normalizeCode } = await import('@/lib/pairing/code')
const { resetSweepGuard } = await import('@/lib/pairing/rateLimit')
const { enrolDevice, sha256Hex } = await import('@/lib/identity')
const claimRoute = await import('@/app/api/pair/claim/route')
const codeRoute = await import('@/app/api/pair/code/route')
const devicesRoute = await import('@/app/api/pair/devices/route')
const rotateRoute = await import('@/app/api/pair/rotate/route')
const workoutsRoute = await import('@/app/api/workouts/route')
const sessionsRoute = await import('@/app/api/sessions/route')

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const useDatabase = (client: unknown): void => {
  holder.client = client
}

const useCookie = (value: string | null): void => {
  holder.cookie = value
}

/** A request from a chosen address, so a test can spend one budget per attempt deliberately. */
const claimRequest = (body: unknown, address = '198.51.100.7'): Request =>
  new Request('http://localhost/api/pair/claim', {
    method: 'POST',
    headers: { 'x-forwarded-for': address, 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/125.0' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const codeRequest = (address = '198.51.100.1'): Request =>
  new Request('http://localhost/api/pair/code', {
    method: 'POST',
    headers: { 'x-forwarded-for': address, 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/125.0' },
  })

const rotateRequest = (address = '198.51.100.2'): Request =>
  new Request('http://localhost/api/pair/rotate', {
    method: 'POST',
    headers: { 'x-forwarded-for': address, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Firefox/126.0' },
  })

/** Mints a space with one device plus one live code, returning the plaintext code. */
async function seedSpaceWithCode(
  fake: PrismaFake,
  address?: string
): Promise<{ code: string; creatorToken: string; userId: string; spaceId: string }> {
  useDatabase(fake)
  useCookie(null)

  const response = await codeRoute.POST(codeRequest(address))
  expect(response.status).toBe(201)

  const body = (await response.json()) as { code: string; userId: string }
  const creatorToken = /bx_device=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? ''
  const space = fake.store.syncSpaces.find((row) => row.userId === body.userId)
  expect(space).toBeDefined()

  return {
    code: body.code,
    creatorToken,
    userId: body.userId,
    spaceId: space?.id ?? '',
  }
}

/** A response reduced to the three things Property 9 compares. */
async function fingerprint(
  response: Response
): Promise<{ status: number; body: string; headers: [string, string][] }> {
  return {
    status: response.status,
    body: await response.text(),
    headers: [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
  }
}

const workoutRow = (id: string, userId: string): FakeStore['workouts'][number] => ({
  id,
  userId,
  name: `Workout ${id}`,
  type: 'BOXING',
  rounds: 3,
  roundSeconds: 180,
  restSeconds: 60,
  prepSeconds: 5,
  isDefault: false,
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
})

const sessionRow = (id: string, userId: string): FakeStore['workoutSessions'][number] => ({
  id,
  userId,
  workoutId: null,
  workoutName: `Session ${id}`,
  type: 'BOXING',
  roundsPlanned: 3,
  roundsCompleted: 3,
  totalDurationMs: 600_000,
  completed: true,
  startedAt: new Date('2025-01-02T00:00:00Z'),
  endedAt: new Date('2025-01-02T00:10:00Z'),
})

beforeEach(() => {
  resetSweepGuard()
  useDatabase(null)
  useCookie(null)
})

/* -------------------------------------------------------------------------- */
/* Property 8 — single use (task 6.4)                                          */
/* -------------------------------------------------------------------------- */

describe('Property 8: A code is consumable at most once', () => {
  /**
   * Every attempt comes from a distinct address, so no attempt is refused for budget reasons and
   * none is slowed by backoff — the only thing that can decide the outcome is the consumption
   * statement itself, which is the point.
   *
   * Depends on the fake's atomic `updateMany`: a fake that ignored `consumedAt: null` would let
   * this pass against a double-consuming implementation.
   *
   * **Validates: Requirements 3.1, 3.2, 3.3**
   */
  it('admits exactly one of any number of concurrent and sequential claims', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 0, max: 3 }),
        async (concurrent, sequential) => {
          const fake = createPrismaFake()
          const { code, spaceId } = await seedSpaceWithCode(fake)

          let address = 0
          const nextAddress = (): string => `203.0.113.${(address += 1)}`

          const concurrentResults = await Promise.all(
            Array.from({ length: concurrent }, () =>
              claimRoute.POST(claimRequest({ code }, nextAddress()))
            )
          )

          const sequentialResults: Response[] = []
          for (let index = 0; index < sequential; index += 1) {
            sequentialResults.push(await claimRoute.POST(claimRequest({ code }, nextAddress())))
          }

          const statuses = [...concurrentResults, ...sequentialResults].map(
            (response) => response.status
          )

          // At most one — and, since the code was live, exactly one — success.
          expect(statuses.filter((status) => status === 200)).toHaveLength(1)
          // Every other attempt takes the uniform failure exit.
          expect(statuses.filter((status) => status === 400)).toHaveLength(
            concurrent + sequential - 1
          )

          // The row is spent exactly once, and only one device joined.
          const rows = fake.store.pairingCodes.filter((row) => row.codeHash === hashCode(code.replace('-', '')))
          expect(rows).toHaveLength(1)
          expect(rows[0].consumedAt).not.toBeNull()
          expect(
            fake.store.pairedDevices.filter((device) => device.syncSpaceId === spaceId)
          ).toHaveLength(2) // the creating device plus the single winner
        }
      ),
      { numRuns: 20 }
    )
  })

  it('rejects a replay of an already consumed code', async () => {
    const fake = createPrismaFake()
    const { code } = await seedSpaceWithCode(fake)

    const first = await claimRoute.POST(claimRequest({ code }, '203.0.113.20'))
    const second = await claimRoute.POST(claimRequest({ code }, '203.0.113.21'))

    expect(first.status).toBe(200)
    expect(second.status).toBe(400)
    await expect(second.json()).resolves.toEqual({
      error: 'That code is not valid. Ask for a new one.',
      reason: 'invalid-code',
    })
  })
})

/* -------------------------------------------------------------------------- */
/* Property 9 — indistinguishable failures (task 6.5)                          */
/* -------------------------------------------------------------------------- */

describe('Property 9: Claim failures are indistinguishable', () => {
  /**
   * Each variant runs against a *fresh* fake with an empty ledger and the same address, so the
   * four responses are compared under identical state — which is exactly the comparison an
   * attacker would make.
   *
   * **Validates: Requirements 5.1, 5.2, 5.3**
   */
  it('answers byte-identically for absent, expired, consumed, and malformed claims', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/),
        fc.oneof(
          fc.constant('{}'),
          fc.constant('not json at all'),
          fc.constant(JSON.stringify({ code: 12345 })),
          fc.constant(JSON.stringify({ code: '' })),
          fc.constant(JSON.stringify({ code: 'O0OO1III' })),
          fc.constant(JSON.stringify({ code: 'x'.repeat(64) }))
        ),
        async (plaintext, malformedBody) => {
          const codeHash = hashCode(plaintext)
          const past = new Date(Date.now() - 60_000)
          const future = new Date(Date.now() + 60_000)

          /** A space and one seeded code row, in whatever lifecycle state is wanted. */
          const withSeededCode = (
            code?: { expiresAt: Date; consumedAt: Date | null }
          ): PrismaFake => {
            const fake = createPrismaFake({
              seed: {
                users: [{ id: 'usr_seed', name: null, email: null, createdAt: past }],
                syncSpaces: [
                  { id: 'spc_seed', userId: 'usr_seed', createdAt: past, rotatedAt: null },
                ],
                pairingCodes: code
                  ? [
                      {
                        id: 'cod_seed',
                        syncSpaceId: 'spc_seed',
                        codeHash,
                        expiresAt: code.expiresAt,
                        consumedAt: code.consumedAt,
                        createdAt: past,
                      },
                    ]
                  : [],
              },
            })
            useDatabase(fake)
            useCookie(null)
            return fake
          }

          // 1. The code never existed.
          withSeededCode()
          const absent = await fingerprint(
            await claimRoute.POST(claimRequest({ code: plaintext }, '192.0.2.9'))
          )

          // 2. The code existed and has expired.
          withSeededCode({ expiresAt: past, consumedAt: null })
          const expired = await fingerprint(
            await claimRoute.POST(claimRequest({ code: plaintext }, '192.0.2.9'))
          )

          // 3. The code existed, is unexpired, and is already spent.
          withSeededCode({ expiresAt: future, consumedAt: past })
          const consumed = await fingerprint(
            await claimRoute.POST(claimRequest({ code: plaintext }, '192.0.2.9'))
          )

          // 4. The body is not a well-formed claim at all.
          withSeededCode({ expiresAt: future, consumedAt: null })
          const malformed = await fingerprint(
            await claimRoute.POST(claimRequest(malformedBody, '192.0.2.9'))
          )

          expect(expired).toEqual(absent)
          expect(consumed).toEqual(absent)
          expect(malformed).toEqual(absent)

          // And the shared shape is the one uniform failure, naming no field and no cause.
          expect(absent.status).toBe(400)
          expect(JSON.parse(absent.body)).toEqual({
            error: 'That code is not valid. Ask for a new one.',
            reason: 'invalid-code',
          })
          expect(absent.headers.some(([name]) => name === 'set-cookie')).toBe(false)
        }
      ),
      { numRuns: 25 }
    )
  })

  it('leaves a live code claimable after a malformed body was rejected', async () => {
    const fake = createPrismaFake()
    const { code } = await seedSpaceWithCode(fake)

    expect((await claimRoute.POST(claimRequest('{}', '192.0.2.30'))).status).toBe(400)
    expect((await claimRoute.POST(claimRequest({ code }, '192.0.2.31'))).status).toBe(200)
  })
})

/* -------------------------------------------------------------------------- */
/* Property 21 — rotation (task 6.8)                                           */
/* -------------------------------------------------------------------------- */

describe('Property 21: Rotation preserves records and revokes devices', () => {
  /**
   * **Validates: Requirements 10.9, 10.10, 10.11**
   */
  it('carries every record across, revokes every device, and kills every code', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        async (extraDevices, workouts, sessions) => {
          const fake = createPrismaFake()
          const { code, creatorToken, userId: oldUserId, spaceId: oldSpaceId } =
            await seedSpaceWithCode(fake)

          // Extra devices in the space, and a couple more live codes.
          for (let index = 0; index < extraDevices; index += 1) {
            await enrolDevice(fake, oldSpaceId, 'Safari on iOS')
          }
          await codeRoute.POST(codeRequest('198.51.100.44'))

          // Records owned by the old identity.
          for (let index = 0; index < workouts; index += 1) {
            fake.store.workouts.push(workoutRow(`wkt-${index}`, oldUserId))
          }
          for (let index = 0; index < sessions; index += 1) {
            fake.store.workoutSessions.push(sessionRow(`ses-${index}`, oldUserId))
          }

          const deviceCountBefore = fake.store.pairedDevices.filter(
            (device) => device.syncSpaceId === oldSpaceId
          ).length
          const codesBefore = fake.store.pairingCodes.filter(
            (row) => row.syncSpaceId === oldSpaceId
          ).length
          expect(codesBefore).toBeGreaterThan(0)

          useCookie(creatorToken)
          const response = await rotateRoute.POST(rotateRequest())
          expect(response.status).toBe(200)

          const body = (await response.json()) as {
            userId: string
            spaceId: string
            revokedDevices: number
          }

          // A brand-new identity, and every device that held the old one is out.
          expect(body.userId).not.toBe(oldUserId)
          expect(body.spaceId).not.toBe(oldSpaceId)
          expect(body.revokedDevices).toBe(deviceCountBefore)
          expect(
            fake.store.pairedDevices.filter((device) => device.syncSpaceId === oldSpaceId)
          ).toHaveLength(0)

          // The caller — and only the caller — is enrolled in the new space.
          expect(
            fake.store.pairedDevices.filter((device) => device.syncSpaceId === body.spaceId)
          ).toHaveLength(1)

          // Every previously live code for the old space is gone, so none remains claimable.
          expect(
            fake.store.pairingCodes.filter((row) => row.syncSpaceId === oldSpaceId)
          ).toHaveLength(0)
          useCookie(null)
          expect((await claimRoute.POST(claimRequest({ code }, '198.51.100.55'))).status).toBe(400)

          // The record set is preserved exactly: same ids, all re-pointed, none left behind.
          expect(fake.store.workouts.filter((row) => row.userId === oldUserId)).toHaveLength(0)
          expect(fake.store.workoutSessions.filter((row) => row.userId === oldUserId)).toHaveLength(0)
          expect(
            fake.store.workouts.filter((row) => row.userId === body.userId).map((row) => row.id).sort()
          ).toEqual(Array.from({ length: workouts }, (_, index) => `wkt-${index}`).sort())
          expect(
            fake.store.workoutSessions
              .filter((row) => row.userId === body.userId)
              .map((row) => row.id)
              .sort()
          ).toEqual(Array.from({ length: sessions }, (_, index) => `ses-${index}`).sort())

          // `rotatedAt` records when it happened, for the UI to show.
          const newSpace = fake.store.syncSpaces.find((space) => space.id === body.spaceId)
          expect(newSpace?.rotatedAt).toBeInstanceOf(Date)

          // The caller's fresh cookie works; its previous token no longer resolves.
          const newToken =
            /bx_device=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? ''
          expect(newToken).not.toBe(creatorToken)
          expect(
            fake.store.pairedDevices.some((device) => device.tokenHash === sha256Hex(creatorToken))
          ).toBe(false)
          expect(
            fake.store.pairedDevices.some((device) => device.tokenHash === sha256Hex(newToken))
          ).toBe(true)
        }
      ),
      { numRuns: 20 }
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Property 15 — sync-space isolation (task 6.9)                               */
/* -------------------------------------------------------------------------- */

describe('Property 15: Sync spaces are isolated', () => {
  /**
   * Two spaces are seeded in one store, and every read is driven through the real handlers with
   * each space's own cookie. The fake scopes nothing implicitly, so a handler missing its
   * `where: { userId }` would return the other space's rows here — which is precisely the leak
   * this property exists to catch.
   *
   * **Validates: Requirements 14.1, 14.2, 14.6**
   */
  it('never returns one space’s records or devices to another', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0), {
          minLength: 1,
          maxLength: 4,
        }),
        async (idsA, idsB) => {
          const fake = createPrismaFake()

          // Two independent spaces, each created through the real endpoint.
          const first = await seedSpaceWithCode(fake, '198.51.100.61')
          const second = await seedSpaceWithCode(fake, '198.51.100.62')
          expect(first.userId).not.toBe(second.userId)

          const own = (prefix: string, ids: readonly string[]): string[] =>
            ids.map((id) => `${prefix}-${id}`)

          for (const id of own('a', idsA)) fake.store.workouts.push(workoutRow(id, first.userId))
          for (const id of own('b', idsB)) fake.store.workouts.push(workoutRow(id, second.userId))
          for (const id of own('a', idsA))
            fake.store.workoutSessions.push(sessionRow(id, first.userId))
          for (const id of own('b', idsB))
            fake.store.workoutSessions.push(sessionRow(id, second.userId))

          // An unpaired device: its records belong to nobody and must be invisible to both.
          fake.store.workouts.push({ ...workoutRow('orphan', 'nobody'), userId: null })

          for (const [space, mine, theirs] of [
            [first, own('a', idsA), own('b', idsB)],
            [second, own('b', idsB), own('a', idsA)],
          ] as const) {
            useCookie(space.creatorToken)

            const workoutsBody = (await (await workoutsRoute.GET()).json()) as {
              workouts: { id: string }[]
            }
            const ids = workoutsBody.workouts.map((workout) => workout.id).sort()
            expect(ids).toEqual([...mine].sort())
            for (const foreign of theirs) expect(ids).not.toContain(foreign)
            expect(ids).not.toContain('orphan')

            const sessionsBody = (await (await sessionsRoute.GET()).json()) as {
              sessions: { id: string }[]
            }
            const sessionIds = sessionsBody.sessions.map((session) => session.id).sort()
            expect(sessionIds).toEqual([...mine].sort())
            for (const foreign of theirs) expect(sessionIds).not.toContain(foreign)

            // The devices endpoint is scoped the same way, by space rather than by request id.
            const devicesBody = (await (await devicesRoute.GET()).json()) as {
              devices: { id: string; isCurrent: boolean }[]
              spaceId: string
            }
            expect(devicesBody.spaceId).toBe(space.spaceId)
            expect(devicesBody.devices).toHaveLength(1)
            expect(devicesBody.devices[0].isCurrent).toBe(true)
          }
        }
      ),
      { numRuns: 20 }
    )
  })

  it('shows an unpaired device nothing at all', async () => {
    const fake = createPrismaFake()
    const space = await seedSpaceWithCode(fake)
    fake.store.workouts.push(workoutRow('private', space.userId))

    useCookie(null)
    expect((await workoutsRoute.GET()).status).toBe(401)
    expect((await sessionsRoute.GET()).status).toBe(401)
    expect((await devicesRoute.GET()).status).toBe(401)

    useCookie('a-forged-token')
    expect((await workoutsRoute.GET()).status).toBe(401)
    expect((await devicesRoute.GET()).status).toBe(401)
  })
})
