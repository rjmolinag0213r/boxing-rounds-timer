// @vitest-environment node

/**
 * The pairing routes' status matrix and the boundaries a property test should not be trusted to
 * hit: a code claimed at exactly `expiresAt`, a space at exactly 10 devices, a space at exactly 3
 * live codes, and a claim admitted again once a device is unlinked from a full space.
 *
 * The status matrix is a finite enumeration, so it is asserted deterministically rather than as a
 * property. Three boundaries are replaced — the OAuth session, the Prisma client (the shared
 * in-memory fake), and the cookie store — and everything else is production code.
 *
 * Requirements: 1.16, 4.6, 10.2, 10.4, 10.5, 10.14, 13.1, 13.2, 13.3, 15.2, 15.8
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import type { AuthResolution } from '@/lib/auth'
import { createPrismaFake, type PrismaFake } from '@/lib/pairing/__fixtures__/prismaFake'

/* -------------------------------------------------------------------------- */
/* Boundaries                                                                  */
/* -------------------------------------------------------------------------- */

const holder = vi.hoisted(() => ({
  client: null as unknown,
  cookie: null as string | null,
}))

vi.mock('@/lib/auth', () => ({ resolveAuth: vi.fn() }))

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

const { resolveAuth } = await import('@/lib/auth')
const { PAIRING_CODE_TTL_MS, hashCode } = await import('@/lib/pairing/code')
const { resetSweepGuard } = await import('@/lib/pairing/rateLimit')
const { MAX_DEVICES_PER_SPACE, MAX_LIVE_CODES_PER_SPACE, enrolDevice } = await import(
  '@/lib/identity'
)
const identityRoute = await import('@/app/api/pair/identity/route')
const codeRoute = await import('@/app/api/pair/code/route')
const claimRoute = await import('@/app/api/pair/claim/route')
const devicesRoute = await import('@/app/api/pair/devices/route')
const deviceIdRoute = await import('@/app/api/pair/devices/[id]/route')
const rotateRoute = await import('@/app/api/pair/rotate/route')

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const useDatabase = (client: unknown): void => {
  holder.client = client
}

const useCookie = (value: string | null): void => {
  holder.cookie = value
}

const useOauth = (resolution: AuthResolution): void => {
  vi.mocked(resolveAuth).mockResolvedValue(resolution)
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/125.0.0.0 Safari/537.36'

const post = (path: string, address: string, body?: unknown): Request =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'x-forwarded-for': address, 'user-agent': USER_AGENT },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })

const del = (id: string): Request =>
  new Request(`http://localhost/api/pair/devices/${id}`, { method: 'DELETE' })

/** A client whose every call fails the way an unreachable database does. */
function unreachableDatabase(): unknown {
  const fail = (): Promise<never> => {
    const error = new Error("Can't reach database server at `db:5432`")
    error.name = 'PrismaClientInitializationError'
    return Promise.reject(error)
  }
  const delegate = {
    create: fail,
    findUnique: fail,
    findFirst: fail,
    findMany: fail,
    count: fail,
    update: fail,
    updateMany: fail,
    delete: fail,
    deleteMany: fail,
  }
  return {
    user: delegate,
    syncSpace: delegate,
    pairingCode: delegate,
    pairedDevice: delegate,
    pairingAttempt: delegate,
    workout: delegate,
    workoutSession: delegate,
    $transaction: fail,
  }
}

const cookieValue = (response: Response): string | null =>
  /bx_device=([^;]*)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? null

/** Creates a space plus one live code through the real endpoint, as device A would. */
async function createSpace(
  fake: PrismaFake,
  address = '198.51.100.1'
): Promise<{ code: string; token: string; userId: string; spaceId: string }> {
  useDatabase(fake)
  useCookie(null)

  const response = await codeRoute.POST(post('/api/pair/code', address))
  expect(response.status).toBe(201)

  const body = (await response.json()) as { code: string; userId: string }
  const space = fake.store.syncSpaces.find((row) => row.userId === body.userId)

  return {
    code: body.code,
    token: cookieValue(response) ?? '',
    userId: body.userId,
    spaceId: space?.id ?? '',
  }
}

/** Fills an address's `CREATE`/`CLAIM` budget by seeding the ledger directly. */
function exhaustBudget(fake: PrismaFake, ipHash: string, kind: 'CREATE' | 'CLAIM', rows: number) {
  for (let index = 0; index < rows; index += 1) {
    fake.store.pairingAttempts.push({
      id: `att-seed-${kind}-${index}`,
      ipHash,
      kind,
      succeeded: false,
      createdAt: new Date(Date.now() - 1000),
    })
  }
}

/** The `ipHash` the routes will derive for an address, so the ledger can be seeded for it. */
const { ipHashFrom } = await import('@/lib/pairing/rateLimit')

beforeEach(() => {
  vi.mocked(resolveAuth).mockReset()
  useOauth({ kind: 'anonymous' })
  resetSweepGuard()
  useDatabase(null)
  useCookie(null)
})

afterEach(() => {
  vi.useRealTimers()
})

/* -------------------------------------------------------------------------- */
/* GET /api/pair/identity                                                      */
/* -------------------------------------------------------------------------- */

describe('GET /api/pair/identity', () => {
  it('answers 200 with the local-only body when no database is configured', async () => {
    useDatabase(null)

    const response = await identityRoute.GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      kind: 'anonymous',
      userId: null,
      deviceId: null,
      syncAvailable: false,
    })
  })

  it('answers 200 anonymous with sync available for an unpaired caller', async () => {
    useDatabase(createPrismaFake())

    const response = await identityRoute.GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      kind: 'anonymous',
      userId: null,
      deviceId: null,
      syncAvailable: true,
    })
  })

  it('answers 200 paired, naming the device, for a paired caller', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake)
    useCookie(space.token)

    const response = await identityRoute.GET()
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body.kind).toBe('paired')
    expect(body.userId).toBe(space.userId)
    expect(body.deviceId).toBe(fake.store.pairedDevices[0].id)
    expect(body.syncAvailable).toBe(true)
  })

  it('answers 200 oauth, with no device id, for a signed-in caller', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake)
    useOauth({ kind: 'authenticated', userId: 'real-account' })
    useCookie(space.token)

    const response = await identityRoute.GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      kind: 'oauth',
      userId: 'real-account',
      deviceId: null,
      syncAvailable: true,
    })
  })

  it('answers 200 with sync unavailable when the database is unreachable', async () => {
    useDatabase(unreachableDatabase())
    useCookie('a-token')

    const response = await identityRoute.GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      kind: 'anonymous',
      userId: null,
      deviceId: null,
      syncAvailable: false,
      reason: 'unreachable',
    })
  })
})

/* -------------------------------------------------------------------------- */
/* POST /api/pair/code                                                         */
/* -------------------------------------------------------------------------- */

describe('POST /api/pair/code', () => {
  it('answers 201 for an anonymous caller, enrolling the creating device', async () => {
    const fake = createPrismaFake()
    useDatabase(fake)

    const response = await codeRoute.POST(post('/api/pair/code', '198.51.100.10'))
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(201)
    expect(body.code).toMatch(/^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/)
    expect(body.ttlMs).toBe(PAIRING_CODE_TTL_MS)
    expect(body.expiresAt).toBeGreaterThan(Date.now())
    expect(body.syncAvailable).toBe(true)
    // The creating device joins its own new space, so its local library will upload.
    expect(cookieValue(response)).toBeTruthy()
    expect(fake.store.users).toHaveLength(1)
    expect(fake.store.syncSpaces).toHaveLength(1)
    expect(fake.store.pairedDevices).toHaveLength(1)
    expect(fake.store.pairedDevices[0].label).toBe('Chrome on macOS')
    // Only the digest is persisted.
    expect(fake.store.pairingCodes[0].codeHash).toBe(
      hashCode(String(body.code).replace('-', ''))
    )
    expect(fake.serialize()).not.toContain(String(body.code).replace('-', ''))
  })

  it('reuses the caller’s existing space and issues no second cookie', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake, '198.51.100.11')
    useCookie(space.token)

    const response = await codeRoute.POST(post('/api/pair/code', '198.51.100.12'))
    const body = (await response.json()) as { userId: string }

    expect(response.status).toBe(201)
    expect(body.userId).toBe(space.userId)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(fake.store.syncSpaces).toHaveLength(1)
    expect(fake.store.pairedDevices).toHaveLength(1)
  })

  it('binds a space to a signed-in caller’s own User row rather than forking one', async () => {
    const fake = createPrismaFake()
    useDatabase(fake)
    useOauth({ kind: 'authenticated', userId: 'real-account' })

    const response = await codeRoute.POST(post('/api/pair/code', '198.51.100.13'))
    const body = (await response.json()) as { userId: string }

    expect(response.status).toBe(201)
    expect(body.userId).toBe('real-account')
    expect(fake.store.syncSpaces).toHaveLength(1)
    expect(fake.store.syncSpaces[0].userId).toBe('real-account')
    // No shadow user was minted, and no device cookie was issued to an OAuth caller.
    expect(fake.store.users).toHaveLength(0)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('answers 409 at exactly three live codes, and creates no fourth', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake, '198.51.100.14')
    useCookie(space.token)

    for (let index = 1; index < MAX_LIVE_CODES_PER_SPACE; index += 1) {
      expect((await codeRoute.POST(post('/api/pair/code', '198.51.100.14'))).status).toBe(201)
    }

    const live = fake.store.pairingCodes.filter(
      (row) => row.consumedAt === null && row.expiresAt.getTime() > Date.now()
    )
    expect(live).toHaveLength(MAX_LIVE_CODES_PER_SPACE)

    const response = await codeRoute.POST(post('/api/pair/code', '198.51.100.14'))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ reason: 'code-limit' })
    expect(fake.store.pairingCodes).toHaveLength(MAX_LIVE_CODES_PER_SPACE)
  })

  it('answers 429 with Retry-After once the hourly budget is spent', async () => {
    const fake = createPrismaFake()
    useDatabase(fake)
    exhaustBudget(fake, ipHashFrom('198.51.100.15'), 'CREATE', 10)

    const response = await codeRoute.POST(post('/api/pair/code', '198.51.100.15'))

    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    await expect(response.json()).resolves.toMatchObject({ reason: 'rate-limited' })
    // Nothing was created for a limited caller.
    expect(fake.store.pairingCodes).toHaveLength(0)
    expect(fake.store.syncSpaces).toHaveLength(0)
  })

  it('answers 503 not-configured with no database and 503 unreachable when it is down', async () => {
    useDatabase(null)
    const absent = await codeRoute.POST(post('/api/pair/code', '198.51.100.16'))
    expect(absent.status).toBe(503)
    await expect(absent.json()).resolves.toMatchObject({ reason: 'not-configured' })

    useDatabase(unreachableDatabase())
    const down = await codeRoute.POST(post('/api/pair/code', '198.51.100.17'))
    expect(down.status).toBe(503)
    await expect(down.json()).resolves.toMatchObject({ reason: 'unreachable' })
  })
})

/* -------------------------------------------------------------------------- */
/* POST /api/pair/claim                                                        */
/* -------------------------------------------------------------------------- */

describe('POST /api/pair/claim', () => {
  it('answers 200 with the identity and a device cookie on success', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake, '198.51.100.20')
    useCookie(null)

    const response = await claimRoute.POST(post('/api/pair/claim', '203.0.113.1', { code: space.code }))
    const body = (await response.json()) as { userId: string; deviceId: string; spaceId: string }

    expect(response.status).toBe(200)
    expect(body.userId).toBe(space.userId)
    expect(body.spaceId).toBe(space.spaceId)
    expect(cookieValue(response)).toBeTruthy()
    expect(fake.store.pairedDevices).toHaveLength(2)
    // Exactly one ledger row, recorded as a success.
    const claims = fake.store.pairingAttempts.filter((row) => row.kind === 'CLAIM')
    expect(claims).toHaveLength(1)
    expect(claims[0].succeeded).toBe(true)
  })

  it('tolerates any casing, dashes, and spaces in the submitted code', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake, '198.51.100.21')
    const noisy = ` ${space.code.replace('-', ' - ').toLowerCase()} `

    const response = await claimRoute.POST(post('/api/pair/claim', '203.0.113.2', { code: noisy }))

    expect(response.status).toBe(200)
  })

  it('answers the uniform 400 for a code that never existed, recording the attempt', async () => {
    const fake = createPrismaFake()
    useDatabase(fake)

    const response = await claimRoute.POST(post('/api/pair/claim', '203.0.113.3', { code: 'ZZZZ-ZZZZ' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'That code is not valid. Ask for a new one.',
      reason: 'invalid-code',
    })
    expect(fake.store.pairingAttempts.filter((row) => row.kind === 'CLAIM')).toHaveLength(1)
  })

  it('rejects a code claimed at exactly expiresAt', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake, '198.51.100.22')
    const expiresAt = fake.store.pairingCodes[0].expiresAt

    // Only `Date` is faked: the handler's own `new Date()` must land exactly on the boundary.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(expiresAt)

    const atBoundary = await claimRoute.POST(
      post('/api/pair/claim', '203.0.113.4', { code: space.code })
    )
    expect(atBoundary.status).toBe(400)

    // One millisecond earlier it would have been admitted, which is what makes the boundary sharp.
    vi.setSystemTime(new Date(expiresAt.getTime() - 1))
    const justBefore = await claimRoute.POST(
      post('/api/pair/claim', '203.0.113.5', { code: space.code })
    )
    expect(justBefore.status).toBe(200)
  })

  it('answers 409 device-limit at exactly ten devices, and records a failed attempt', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake, '198.51.100.23')

    for (let index = 1; index < MAX_DEVICES_PER_SPACE; index += 1) {
      await enrolDevice(fake, space.spaceId, 'Safari on iOS')
    }
    expect(fake.store.pairedDevices).toHaveLength(MAX_DEVICES_PER_SPACE)

    useCookie(null)
    const response = await claimRoute.POST(
      post('/api/pair/claim', '203.0.113.6', { code: space.code })
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ reason: 'device-limit' })
    expect(fake.store.pairedDevices).toHaveLength(MAX_DEVICES_PER_SPACE)
    const claims = fake.store.pairingAttempts.filter((row) => row.kind === 'CLAIM')
    expect(claims).toHaveLength(1)
    expect(claims[0].succeeded).toBe(false)
  })

  it('admits a claim again once a device is unlinked from a full space', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake, '198.51.100.24')

    for (let index = 1; index < MAX_DEVICES_PER_SPACE; index += 1) {
      await enrolDevice(fake, space.spaceId, 'Safari on iOS')
    }

    // Full: the first claim is refused.
    useCookie(null)
    expect(
      (await claimRoute.POST(post('/api/pair/claim', '203.0.113.7', { code: space.code }))).status
    ).toBe(409)

    // The owner unlinks somebody else's device, freeing a slot.
    useCookie(space.token)
    const victim = fake.store.pairedDevices.find((device) => device.tokenHash !== undefined && device.label === 'Safari on iOS')
    const unlink = await deviceIdRoute.DELETE(del(victim?.id ?? ''), {
      params: { id: victim?.id ?? '' },
    })
    expect(unlink.status).toBe(200)
    expect(fake.store.pairedDevices).toHaveLength(MAX_DEVICES_PER_SPACE - 1)

    // A fresh code now pairs, so the cap is recoverable (requirement 15.8).
    const second = await codeRoute.POST(post('/api/pair/code', '198.51.100.25'))
    const { code } = (await second.json()) as { code: string }

    useCookie(null)
    expect((await claimRoute.POST(post('/api/pair/claim', '203.0.113.8', { code }))).status).toBe(200)
  })

  it('answers 429 once the address has spent its claim budget', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake, '198.51.100.26')
    exhaustBudget(fake, ipHashFrom('203.0.113.9'), 'CLAIM', 5)

    const response = await claimRoute.POST(
      post('/api/pair/claim', '203.0.113.9', { code: space.code })
    )

    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    // The code was never touched: a limited caller learns nothing about it.
    expect(fake.store.pairingCodes[0].consumedAt).toBeNull()
  })

  it('answers 503 with no database, before reading the submitted code', async () => {
    useDatabase(null)

    const response = await claimRoute.POST(post('/api/pair/claim', '203.0.113.10', { code: 'AAAA-AAAA' }))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ reason: 'not-configured' })
  })

  it('answers 503 unreachable when the database is down', async () => {
    useDatabase(unreachableDatabase())

    const response = await claimRoute.POST(post('/api/pair/claim', '203.0.113.11', { code: 'AAAA-AAAA' }))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ reason: 'unreachable' })
  })
})

/* -------------------------------------------------------------------------- */
/* GET /api/pair/devices and DELETE /api/pair/devices/[id]                     */
/* -------------------------------------------------------------------------- */

describe('GET /api/pair/devices', () => {
  it('answers 200 with the caller’s own devices, flagging the current one', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake, '198.51.100.30')
    const other = await enrolDevice(fake, space.spaceId, 'Firefox on Linux')
    useCookie(space.token)

    const response = await devicesRoute.GET()
    const body = (await response.json()) as {
      devices: { id: string; label: string; isCurrent: boolean; lastSeenAt: number }[]
      spaceId: string
      rotatedAt: number | null
    }

    expect(response.status).toBe(200)
    expect(body.spaceId).toBe(space.spaceId)
    expect(body.rotatedAt).toBeNull()
    expect(body.devices).toHaveLength(2)
    expect(body.devices.filter((device) => device.isCurrent)).toHaveLength(1)
    expect(body.devices.find((device) => device.id === other.deviceId)?.label).toBe(
      'Firefox on Linux'
    )
    expect(typeof body.devices[0].lastSeenAt).toBe('number')
  })

  it('answers 200 with an empty list for a signed-in caller who has never paired', async () => {
    useDatabase(createPrismaFake())
    useOauth({ kind: 'authenticated', userId: 'real-account' })

    const response = await devicesRoute.GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ devices: [], spaceId: null, rotatedAt: null })
  })

  it('answers 401 for an anonymous caller and 503 with no database', async () => {
    useDatabase(createPrismaFake())
    expect((await devicesRoute.GET()).status).toBe(401)

    useDatabase(null)
    expect((await devicesRoute.GET()).status).toBe(503)
  })
})

describe('DELETE /api/pair/devices/[id]', () => {
  it('unlinks another device without clearing the caller’s cookie', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake, '198.51.100.31')
    const other = await enrolDevice(fake, space.spaceId, 'Firefox on Linux')
    useCookie(space.token)

    const response = await deviceIdRoute.DELETE(del(other.deviceId), {
      params: { id: other.deviceId },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ id: other.deviceId, wasCurrent: false })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(fake.store.pairedDevices).toHaveLength(1)
  })

  it('clears the cookie when the caller unlinks its own device', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake, '198.51.100.32')
    const own = fake.store.pairedDevices[0].id
    useCookie(space.token)

    const response = await deviceIdRoute.DELETE(del(own), { params: { id: own } })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ id: own, wasCurrent: true })
    // An expiry in the past with an empty value: the browser drops the cookie immediately.
    expect(response.headers.get('set-cookie')).toContain('bx_device=;')
    expect(response.headers.get('set-cookie')).toContain('Expires=Thu, 01 Jan 1970')
    expect(fake.store.pairedDevices).toHaveLength(0)
  })

  it('answers an identical 404 for an absent id and for another space’s device', async () => {
    const fake = createPrismaFake()
    const mine = await createSpace(fake, '198.51.100.33')
    const theirs = await createSpace(fake, '198.51.100.34')
    const foreignId = fake.store.pairedDevices.find(
      (device) => device.syncSpaceId === theirs.spaceId
    )?.id

    useCookie(mine.token)
    const absent = await deviceIdRoute.DELETE(del('dev_nope'), { params: { id: 'dev_nope' } })
    const foreign = await deviceIdRoute.DELETE(del(foreignId ?? ''), {
      params: { id: foreignId ?? '' },
    })

    expect(absent.status).toBe(404)
    expect(foreign.status).toBe(404)
    expect(await absent.text()).toBe(await foreign.text())
    // The other space's device is untouched: ownership is never disclosed, nor overridden.
    expect(
      fake.store.pairedDevices.filter((device) => device.syncSpaceId === theirs.spaceId)
    ).toHaveLength(1)
  })

  it('answers 401 for an anonymous caller and 503 with no database', async () => {
    useDatabase(createPrismaFake())
    expect((await deviceIdRoute.DELETE(del('dev_1'), { params: { id: 'dev_1' } })).status).toBe(401)

    useDatabase(null)
    expect((await deviceIdRoute.DELETE(del('dev_1'), { params: { id: 'dev_1' } })).status).toBe(503)
  })
})

/* -------------------------------------------------------------------------- */
/* POST /api/pair/rotate                                                       */
/* -------------------------------------------------------------------------- */

describe('POST /api/pair/rotate', () => {
  it('answers 200 with the new identity and a fresh cookie', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake, '198.51.100.40')
    await enrolDevice(fake, space.spaceId, 'Safari on iOS')
    useCookie(space.token)

    const response = await rotateRoute.POST(post('/api/pair/rotate', '198.51.100.41'))
    const body = (await response.json()) as {
      userId: string
      spaceId: string
      revokedDevices: number
    }

    expect(response.status).toBe(200)
    expect(body.userId).not.toBe(space.userId)
    expect(body.revokedDevices).toBe(2)
    expect(cookieValue(response)).toBeTruthy()
    expect(cookieValue(response)).not.toBe(space.token)
  })

  it('answers 401 for an anonymous caller', async () => {
    useDatabase(createPrismaFake())

    expect((await rotateRoute.POST(post('/api/pair/rotate', '198.51.100.42'))).status).toBe(401)
  })

  it('answers 404 for a signed-in caller with no space to rotate', async () => {
    useDatabase(createPrismaFake())
    useOauth({ kind: 'authenticated', userId: 'real-account' })

    const response = await rotateRoute.POST(post('/api/pair/rotate', '198.51.100.43'))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ reason: 'no-space' })
  })

  it('answers 429 once the create budget is spent, rotating nothing', async () => {
    const fake = createPrismaFake()
    const space = await createSpace(fake, '198.51.100.44')
    exhaustBudget(fake, ipHashFrom('198.51.100.45'), 'CREATE', 10)
    useCookie(space.token)

    const response = await rotateRoute.POST(post('/api/pair/rotate', '198.51.100.45'))

    expect(response.status).toBe(429)
    expect(fake.store.syncSpaces).toHaveLength(1)
    expect(fake.store.pairedDevices).toHaveLength(1)
  })

  it('answers 503 with no database and 503 unreachable when it is down', async () => {
    useDatabase(null)
    expect((await rotateRoute.POST(post('/api/pair/rotate', '198.51.100.46'))).status).toBe(503)

    useDatabase(unreachableDatabase())
    useCookie('a-token')
    const down = await rotateRoute.POST(post('/api/pair/rotate', '198.51.100.47'))
    expect(down.status).toBe(503)
    await expect(down.json()).resolves.toMatchObject({ reason: 'unreachable' })
  })
})
