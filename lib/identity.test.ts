// @vitest-environment node

/**
 * Tests for the identity narrow waist.
 *
 * Three boundaries are replaced and nothing else: `@/lib/auth` (the OAuth session), `@/lib/db`
 * (the Prisma client, backed by the shared in-memory fake), and `next/headers` (the cookie
 * store). Everything else — hashing, the allow-list, the throttle, the cookie attributes — is
 * the real implementation, because those are exactly the things the properties are about.
 *
 * Covers tasks 5.4–5.9: Properties 16–20 plus the device-label and `lastSeenAt` unit tests.
 *
 * Requirements: 6.2, 6.3, 6.5, 6.6, 7.2, 7.3, 7.4, 7.6, 7.10, 10.6, 13.4, 14.5, 15.5, 15.6
 */

import fc from 'fast-check'
import { NextResponse } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
      name === 'bx_device' && holder.cookie !== null
        ? { name, value: holder.cookie }
        : undefined,
  }),
}))

const { resolveAuth } = await import('@/lib/auth')
const {
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  DEVICE_COOKIE_NAME,
  DEVICE_LABEL_MAX_LENGTH,
  LAST_SEEN_THROTTLE_MS,
  UNKNOWN_DEVICE_LABEL,
  createSyncSpaceWithDevice,
  deviceCookieOptions,
  deviceLabelFrom,
  enrolDevice,
  resolveIdentity,
  setDeviceCookie,
  sha256Hex,
} = await import('@/lib/identity')

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const useOauth = (resolution: AuthResolution): void => {
  vi.mocked(resolveAuth).mockResolvedValue(resolution)
}

const useDatabase = (client: unknown): void => {
  holder.client = client
}

const useCookie = (value: string | null): void => {
  holder.cookie = value
}

/** A client whose every read fails the way an unreachable database does. */
function unreachableDatabase(): unknown {
  const fail = (): Promise<never> => {
    const error = new Error("Can't reach database server at `db:5432`")
    error.name = 'PrismaClientInitializationError'
    return Promise.reject(error)
  }
  return { pairedDevice: { findUnique: fail, update: fail } }
}

/** Settles the fire-and-forget `lastSeenAt` write, so its effect can be asserted. */
const settleBackgroundWrites = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

beforeEach(() => {
  vi.mocked(resolveAuth).mockReset()
  useOauth({ kind: 'anonymous' })
  useDatabase(null)
  useCookie(null)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/* -------------------------------------------------------------------------- */
/* Property 16 — OAuth precedence (task 5.4)                                   */
/* -------------------------------------------------------------------------- */

describe('Property 16: OAuth takes precedence deterministically', () => {
  /**
   * All four combinations of OAuth presence and cookie presence, plus the split between a
   * cookie that matches a live device and one that does not.
   *
   * **Validates: Requirements 7.2, 7.3, 7.4**
   */
  it('resolves as a pure function of OAuth presence and cookie validity', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        async (hasOauth, hasCookie, cookieMatches) => {
          const fake = createPrismaFake()
          useDatabase(fake)

          const { rawToken } = await createSyncSpaceWithDevice(fake, 'Chrome on macOS')
          const spaceUserId = fake.store.syncSpaces[0].userId

          useOauth(hasOauth ? { kind: 'authenticated', userId: 'oauth-user' } : { kind: 'anonymous' })
          useCookie(hasCookie ? (cookieMatches ? rawToken : 'a-forged-token') : null)

          const resolution = await resolveIdentity()

          if (hasOauth) {
            // Unconditional: the device cookie is not even read.
            expect(resolution).toEqual({
              kind: 'authenticated',
              userId: 'oauth-user',
              source: 'oauth',
            })
            return
          }

          if (hasCookie && cookieMatches) {
            expect(resolution.kind).toBe('authenticated')
            if (resolution.kind !== 'authenticated') return
            expect(resolution.source).toBe('paired')
            expect(resolution.userId).toBe(spaceUserId)
            expect(resolution.deviceId).toBe(fake.store.pairedDevices[0].id)
            return
          }

          expect(resolution).toEqual({ kind: 'anonymous' })
        }
      ),
      { numRuns: 60 }
    )
  })

  it('prefers OAuth even when the device cookie names a different space', async () => {
    const fake = createPrismaFake()
    useDatabase(fake)
    const { rawToken } = await createSyncSpaceWithDevice(fake, 'Firefox on Linux')

    useOauth({ kind: 'authenticated', userId: 'real-account' })
    useCookie(rawToken)

    await expect(resolveIdentity()).resolves.toEqual({
      kind: 'authenticated',
      userId: 'real-account',
      source: 'oauth',
    })
  })

  it('is anonymous with a cookie but no database, because local-only is not a fault', async () => {
    useDatabase(null)
    useCookie('some-token')

    await expect(resolveIdentity()).resolves.toEqual({ kind: 'anonymous' })
  })
})

/* -------------------------------------------------------------------------- */
/* Property 17 — a database fault is never anonymous (task 5.5)                */
/* -------------------------------------------------------------------------- */

describe('Property 17: A database fault never resolves as anonymous', () => {
  /**
   * A connectivity fault raised while resolving identity must surface as `database-error`, so
   * the data routes answer `503`. Answering `401` would tell the client it had been signed out.
   *
   * **Validates: Requirements 7.6, 13.4**
   */
  it('reports database-error for any thrown fault, never anonymous', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant(new Error("Can't reach database server at `db:5432`")),
          fc.constant(Object.assign(new Error('timeout'), { code: 'P1008' })),
          fc.constant(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })),
          fc.string().map((message) => new Error(message))
        ),
        fc.string({ minLength: 1, maxLength: 60 }),
        async (error, token) => {
          useDatabase({
            pairedDevice: {
              findUnique: () => Promise.reject(error),
              update: () => Promise.reject(error),
            },
          })
          useCookie(token)

          const resolution = await resolveIdentity()

          expect(resolution.kind).toBe('database-error')
          expect(resolution.kind).not.toBe('anonymous')
        }
      ),
      { numRuns: 40 }
    )
  })

  it('propagates a database-error raised by the OAuth resolver', async () => {
    const error = new Error('session store unreachable')
    useOauth({ kind: 'database-error', error })

    await expect(resolveIdentity()).resolves.toEqual({ kind: 'database-error', error })
  })

  it('reports database-error rather than anonymous for an unreachable client', async () => {
    useDatabase(unreachableDatabase())
    useCookie('a-token')

    const resolution = await resolveIdentity()
    expect(resolution.kind).toBe('database-error')
  })
})

/* -------------------------------------------------------------------------- */
/* Property 18 — revocation (task 5.6)                                         */
/* -------------------------------------------------------------------------- */

describe('Property 18: Revocation is immediately effective', () => {
  /**
   * Deleting the `PairedDevice` row ends the session on the very next request — which is the
   * whole reason the credential is an opaque token verified by lookup rather than a signed JWT.
   *
   * **Validates: Requirements 10.6, 14.5**
   */
  it('resolves anonymous for every request after the device row is deleted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 3 }),
        async (deviceCount, requestsAfterRevocation) => {
          const fake = createPrismaFake()
          useDatabase(fake)

          const { spaceId, rawToken } = await createSyncSpaceWithDevice(fake, 'Chrome on Windows')
          const tokens = [rawToken]
          for (let index = 1; index < deviceCount; index += 1) {
            const enrolled = await enrolDevice(fake, spaceId, 'Safari on iOS')
            tokens.push(enrolled.rawToken)
          }

          // Live before revocation.
          useCookie(rawToken)
          expect((await resolveIdentity()).kind).toBe('authenticated')

          await fake.pairedDevice.delete({ where: { tokenHash: sha256Hex(rawToken) } })

          for (let attempt = 0; attempt < requestsAfterRevocation; attempt += 1) {
            expect(await resolveIdentity()).toEqual({ kind: 'anonymous' })
          }

          // Every other device in the space is untouched: revocation is per device.
          for (const other of tokens.slice(1)) {
            useCookie(other)
            expect((await resolveIdentity()).kind).toBe('authenticated')
          }
        }
      ),
      { numRuns: 30 }
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Property 19 — token hashing (task 5.7)                                      */
/* -------------------------------------------------------------------------- */

describe('Property 19: Token hashing is deterministic and one-way in storage', () => {
  /**
   * The stored digest is 64 lowercase hex characters and a deterministic function of the token,
   * and the raw token appears in no persisted row — so a database leak yields no credential.
   *
   * **Validates: Requirements 6.2, 6.3**
   */
  it('persists only a deterministic digest, never the raw token', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (enrolments) => {
        const fake = createPrismaFake()
        const { spaceId, rawToken, deviceId } = await createSyncSpaceWithDevice(fake, 'Chrome')

        const issued = [{ deviceId, rawToken }]
        for (let index = 1; index < enrolments; index += 1) {
          issued.push(await enrolDevice(fake, spaceId, 'Edge on Windows'))
        }

        const serialized = fake.serialize()

        for (const { deviceId: id, rawToken: token } of issued) {
          const row = fake.store.pairedDevices.find((device) => device.id === id)
          expect(row).toBeDefined()
          expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
          // Deterministic in the token, and equal to a second independent computation.
          expect(row?.tokenHash).toBe(sha256Hex(token))
          expect(sha256Hex(token)).toBe(sha256Hex(token))
          // One-way in storage: nothing in the store carries the plaintext.
          expect(serialized).not.toContain(token)
        }

        // Distinct tokens, and therefore distinct digests, for every device.
        const digests = new Set(fake.store.pairedDevices.map((device) => device.tokenHash))
        expect(digests.size).toBe(enrolments)
      }),
      { numRuns: 30 }
    )
  })

  it('issues a 256-bit base64url token', async () => {
    const fake = createPrismaFake()
    const { rawToken } = await createSyncSpaceWithDevice(fake, 'Chrome on macOS')

    expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Buffer.from(rawToken, 'base64url')).toHaveLength(32)
  })
})

/* -------------------------------------------------------------------------- */
/* Property 20 — cookie attributes (task 5.8)                                  */
/* -------------------------------------------------------------------------- */

describe('Property 20: Issued cookies always carry their security attributes', () => {
  /**
   * **Validates: Requirements 6.5, 6.6**
   */
  it('always sets HttpOnly, SameSite=Lax, Path=/ and the 400-day max age', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('production', 'development', 'test'),
        fc.string({ minLength: 1, maxLength: 64 }),
        (nodeEnv, token) => {
          vi.stubEnv('NODE_ENV', nodeEnv as 'production' | 'development' | 'test')

          const options = deviceCookieOptions()
          expect(options.httpOnly).toBe(true)
          expect(options.sameSite).toBe('lax')
          expect(options.path).toBe('/')
          expect(options.maxAge).toBe(DEVICE_COOKIE_MAX_AGE_SECONDS)
          expect(options.secure).toBe(nodeEnv === 'production')

          const header = setDeviceCookie(NextResponse.json({ ok: true }), token).headers.get(
            'set-cookie'
          )
          expect(header).toContain('HttpOnly')
          expect(header).toContain('SameSite=lax')
          expect(header).toContain('Path=/')
          expect(header?.includes('Secure')).toBe(nodeEnv === 'production')
        }
      ),
      { numRuns: 40 }
    )
  })

  /**
   * The deterministic companion assertion: the exact attribute set, in both environments.
   *
   * `Expires` is dropped before comparison because Next derives it from `Max-Age` at the instant
   * of the call, so its value is a clock reading rather than a property of the cookie. Its
   * presence is asserted separately.
   */
  const attributesOf = (header: string | null): string =>
    (header ?? '')
      .split('; ')
      .filter((attribute) => !attribute.startsWith('Expires='))
      .join('; ')

  it('emits the exact Set-Cookie attribute string outside production', () => {
    vi.stubEnv('NODE_ENV', 'development')

    const header = setDeviceCookie(NextResponse.json({}), 'raw-token').headers.get('set-cookie')

    expect(header).toContain('Expires=')
    expect(attributesOf(header)).toBe(
      'bx_device=raw-token; Path=/; Max-Age=34560000; HttpOnly; SameSite=lax'
    )
  })

  it('emits the exact Set-Cookie attribute string in production', () => {
    vi.stubEnv('NODE_ENV', 'production')

    const header = setDeviceCookie(NextResponse.json({}), 'raw-token').headers.get('set-cookie')

    expect(attributesOf(header)).toBe(
      'bx_device=raw-token; Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=lax'
    )
  })

  it('names the cookie bx_device and caps its life at 400 days', () => {
    expect(DEVICE_COOKIE_NAME).toBe('bx_device')
    expect(DEVICE_COOKIE_MAX_AGE_SECONDS).toBe(34_560_000)
  })
})

/* -------------------------------------------------------------------------- */
/* Task 5.9 — device labels and lastSeenAt throttling                          */
/* -------------------------------------------------------------------------- */

describe('deviceLabelFrom (requirements 15.5, 15.6)', () => {
  const cases: readonly [string, string][] = [
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Chrome on macOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0 Mobile/15E148 Safari/604.1',
      'Chrome on iPadOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    [
      'Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0',
      'Firefox on Android',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0', 'Firefox on Linux'],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Chrome on ChromeOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
      'Samsung Internet on Android',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/110.0.0.0',
      'Opera on Windows',
    ],
  ]

  it.each(cases)('maps %# to an allow-listed label', (userAgent, expected) => {
    expect(deviceLabelFrom(userAgent)).toBe(expected)
  })

  it('yields Unknown device for an absent, empty, or unrecognised agent', () => {
    expect(deviceLabelFrom(null)).toBe(UNKNOWN_DEVICE_LABEL)
    expect(deviceLabelFrom(undefined)).toBe(UNKNOWN_DEVICE_LABEL)
    expect(deviceLabelFrom('')).toBe(UNKNOWN_DEVICE_LABEL)
    expect(deviceLabelFrom('   ')).toBe(UNKNOWN_DEVICE_LABEL)
    expect(deviceLabelFrom('curl/8.6.0')).toBe(UNKNOWN_DEVICE_LABEL)
  })

  it('never returns raw User-Agent text, and never exceeds 64 characters', () => {
    const allowed = new Set([
      ...cases.map(([, label]) => label),
      UNKNOWN_DEVICE_LABEL,
      'Chrome',
      'Safari',
      'Firefox',
      'Edge',
      'Opera',
      'Samsung Internet',
      'macOS',
      'Windows',
      'iOS',
      'iPadOS',
      'Android',
      'ChromeOS',
      'Linux',
    ])

    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: 'binary' })), (userAgent) => {
        const label = deviceLabelFrom(userAgent)
        expect(label.length).toBeLessThanOrEqual(DEVICE_LABEL_MAX_LENGTH)
        // Every producible label is drawn from the fixed allow-list, so a hostile agent string
        // cannot become a stored value.
        expect(
          allowed.has(label) ||
            /^(Chrome|Safari|Firefox|Edge|Opera|Samsung Internet) on (macOS|Windows|iOS|iPadOS|Android|ChromeOS|Linux)$/.test(
              label
            )
        ).toBe(true)
      })
    )
  })
})

describe('lastSeenAt throttling (requirement 7.10)', () => {
  it('writes lastSeenAt when the stored value is more than an hour old', async () => {
    const fake = createPrismaFake()
    useDatabase(fake)
    const { rawToken, deviceId } = await createSyncSpaceWithDevice(fake, 'Chrome on macOS')
    useCookie(rawToken)

    const stale = new Date(Date.now() - LAST_SEEN_THROTTLE_MS - 1000)
    await fake.pairedDevice.update({ where: { id: deviceId }, data: { lastSeenAt: stale } })

    expect((await resolveIdentity()).kind).toBe('authenticated')
    await settleBackgroundWrites()

    const row = fake.store.pairedDevices.find((device) => device.id === deviceId)
    expect(row?.lastSeenAt.getTime()).toBeGreaterThan(stale.getTime())
  })

  it('issues no write on a second resolution within the hour', async () => {
    const fake = createPrismaFake()
    useDatabase(fake)
    const { rawToken, deviceId } = await createSyncSpaceWithDevice(fake, 'Chrome on macOS')
    useCookie(rawToken)

    const justNow = new Date(Date.now() - 60 * 1000)
    await fake.pairedDevice.update({ where: { id: deviceId }, data: { lastSeenAt: justNow } })

    await resolveIdentity()
    await resolveIdentity()
    await settleBackgroundWrites()

    const row = fake.store.pairedDevices.find((device) => device.id === deviceId)
    expect(row?.lastSeenAt.getTime()).toBe(justNow.getTime())
  })

  it('still completes the request when the lastSeenAt write fails', async () => {
    const fake = createPrismaFake()
    const { rawToken, deviceId } = await createSyncSpaceWithDevice(fake, 'Chrome on macOS')
    await fake.pairedDevice.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date(Date.now() - LAST_SEEN_THROTTLE_MS - 1000) },
    })

    // A client that reads fine and writes badly: the resolution must not notice.
    useDatabase({
      pairedDevice: {
        findUnique: fake.pairedDevice.findUnique,
        update: () => Promise.reject(new Error('write failed')),
      },
    })
    useCookie(rawToken)

    const resolution = await resolveIdentity()
    await settleBackgroundWrites()

    expect(resolution.kind).toBe('authenticated')
  })
})
