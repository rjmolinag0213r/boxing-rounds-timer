/**
 * The identity narrow waist: one function that turns either identity source into a `userId`.
 *
 * There are two ways to own server-side records in this app — an OAuth account and a paired
 * device — and exactly one place that knows it. `resolveIdentity()` is kind-compatible with
 * `resolveAuth()` in `lib/auth.ts` (identical `kind` values, identical `userId` field), so the
 * three existing data routes adopt it by swapping one aliased import and changing nothing else.
 * That is what keeps their bodies, their queries, and their status codes byte-identical, and it
 * is why `lib/auth.ts` is not modified: this feature supplies an identity, not new merge logic.
 *
 * The security-relevant choices here, in one place:
 *
 * - **OAuth wins.** A verified third-party account outranks an anonymous bearer cookie, and the
 *   precedence never flips spontaneously because OAuth presence is an explicit user action.
 * - **A database fault is never `anonymous`.** A connectivity error resolves as `database-error`
 *   so callers answer `503`; answering `401` would tell a client it had been signed out and
 *   invite it to discard its session.
 * - **An absent database is not a fault.** Local-only is a supported state, so no cookie and no
 *   `DATABASE_URL` both resolve as `anonymous`.
 * - **Tokens are opaque, hashed at rest, and revoked by row deletion.** `node:crypto` only —
 *   no `jsonwebtoken`, no `bcryptjs`, therefore no signing secret and no new environment
 *   variable.
 *
 * Requirements: 6.1–6.10, 7.1–7.10, 15.5, 15.6, 16.4, 13.9
 */

import { createHash, randomBytes } from 'node:crypto'

import { cookies } from 'next/headers'

import { resolveAuth } from '@/lib/auth'
import { getPrismaClient } from '@/lib/db'

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** The device-token cookie's name (requirement 6.5). */
export const DEVICE_COOKIE_NAME = 'bx_device'

/** 400 days, the Chrome cap: a pairing left in a drawer should still work (requirement 6.5). */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 400

/** 32 bytes of CSPRNG output — 256 bits, base64url-encoded (requirement 6.1). */
export const DEVICE_TOKEN_BYTES = 32

/** At most one `lastSeenAt` write per device per hour (requirement 7.10). */
export const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000

/** The label cap enforced on every allow-list entry (requirement 15.5). */
export const DEVICE_LABEL_MAX_LENGTH = 64

/** The label used whenever the User-Agent is absent or unrecognised (requirement 15.5). */
export const UNKNOWN_DEVICE_LABEL = 'Unknown device'

/** At most 10 devices per space (requirement 15.1). */
export const MAX_DEVICES_PER_SPACE = 10

/** At most 3 unconsumed, unexpired codes per space (requirement 1.16). */
export const MAX_LIVE_CODES_PER_SPACE = 3

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type IdentityId = string

/** Which credential produced the identity. Additive: callers that do not care ignore it. */
export type IdentitySource = 'oauth' | 'paired'

/**
 * How a route handler should treat the caller.
 *
 * Intentionally kind-compatible with `AuthResolution` in `lib/auth.ts`: the three `kind` values
 * are identical and `userId` sits in the same place, so the existing data routes swap one import
 * and nothing else (requirement 7.1).
 */
export type IdentityResolution =
  | { kind: 'anonymous' }
  | {
      kind: 'authenticated'
      userId: IdentityId
      source: IdentitySource
      deviceId?: string
    }
  | { kind: 'database-error'; error: unknown }

/**
 * The slice of the Prisma client the token issuer writes through.
 *
 * Structural rather than `PrismaClient` for the same reason `RateLimitDb` is: the in-memory fake
 * satisfies it with no cast at the call site, and this module can never construct a client of its
 * own during a build with no `DATABASE_URL` (requirement 13.9).
 */
export interface IdentityWriteDb {
  user: { create(args: { data: Record<string, never> }): Promise<{ id: string }> }
  syncSpace: {
    create(args: {
      data: { userId: string; rotatedAt?: Date }
    }): Promise<{ id: string; userId: string }>
  }
  pairedDevice: {
    create(args: {
      data: { syncSpaceId: string; tokenHash: string; label: string }
    }): Promise<{ id: string }>
  }
}

/** The same slice, plus the transaction runner that makes space creation atomic. */
export interface IdentityDb extends IdentityWriteDb {
  /**
   * Returns `Promise<unknown>` deliberately. The real client's `$transaction` is overloaded and
   * the in-memory fake's resolves to `T | unknown[]`; widening the result here is what lets both
   * satisfy this interface, at the cost of one narrowing assertion inside this module.
   */
  $transaction(body: (tx: IdentityWriteDb) => Promise<unknown>): Promise<unknown>
}

/** The slice the resolver reads through. */
export interface IdentityReadDb {
  pairedDevice: {
    findUnique(args: {
      where: { tokenHash: string }
      select: {
        id: true
        lastSeenAt: true
        syncSpace: { select: { userId: true } }
      }
    }): Promise<{
      id: string
      lastSeenAt: Date
      syncSpace: { userId: string } | null
    } | null>
    update(args: {
      where: { id: string }
      data: { lastSeenAt: Date }
    }): Promise<unknown>
  }
}

/** What issuing a device token yields. The raw token never leaves the `Set-Cookie` header. */
export interface DeviceEnrolment {
  deviceId: string
  rawToken: string
}

/** What creating a whole new identity yields. */
export interface SpaceCreation extends DeviceEnrolment {
  userId: IdentityId
  spaceId: string
}

/** The cookie attributes, as `NextResponse.cookies.set` wants them. */
export interface DeviceCookieOptions {
  httpOnly: true
  secure: boolean
  sameSite: 'lax'
  path: '/'
  maxAge: number
}

/* -------------------------------------------------------------------------- */
/* Hashing and cookie options                                                  */
/* -------------------------------------------------------------------------- */

/** SHA-256 hex: 64 lowercase hexadecimal characters (requirement 6.2). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * The one shared cookie-options source (requirements 6.5, 6.6).
 *
 * A function rather than a frozen constant for exactly one reason: `secure` depends on
 * `NODE_ENV`, and reading it at module load would bake the development value into a production
 * bundle — and would make the two-environment assertion in the tests impossible to write
 * honestly. `secure` is false outside production so that `http://localhost` keeps working.
 */
export function deviceCookieOptions(): DeviceCookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
  }
}

/** The minimal response surface {@link setDeviceCookie} needs, so tests need no `NextResponse`. */
export interface CookieCarrier {
  cookies: {
    set(name: string, value: string, options: DeviceCookieOptions): unknown
    delete(name: string): unknown
  }
}

/**
 * Attaches a freshly issued device token to a response.
 *
 * Every issue site goes through here, which is what makes "an issued cookie always carries its
 * security attributes" a structural fact rather than a convention four routes have to remember.
 */
export function setDeviceCookie<T extends CookieCarrier>(response: T, rawToken: string): T {
  response.cookies.set(DEVICE_COOKIE_NAME, rawToken, deviceCookieOptions())
  return response
}

/** Clears the device cookie — used when a caller unlinks its own device (requirement 10.5). */
export function clearDeviceCookie<T extends CookieCarrier>(response: T): T {
  response.cookies.delete(DEVICE_COOKIE_NAME)
  return response
}

/* -------------------------------------------------------------------------- */
/* Device labels                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The browser allow-list, most specific first.
 *
 * Order matters and is the whole difficulty of User-Agent sniffing: every Chromium browser
 * claims to be Chrome, and Chrome claims to be Safari, so Edge and Opera and Samsung Internet
 * must be tested before Chrome, and Chrome before Safari.
 */
const BROWSER_ALLOW_LIST: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\bEdg(?:e|A|iOS)?\//i, label: 'Edge' },
  { pattern: /\b(?:OPR|Opera)\//i, label: 'Opera' },
  { pattern: /\bSamsungBrowser\//i, label: 'Samsung Internet' },
  { pattern: /\b(?:FxiOS|Firefox)\//i, label: 'Firefox' },
  { pattern: /\b(?:CriOS|Chrome|Chromium)\//i, label: 'Chrome' },
  { pattern: /\bSafari\//i, label: 'Safari' },
]

/** The operating-system allow-list, likewise most specific first. */
const OS_ALLOW_LIST: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\biPad\b/i, label: 'iPadOS' },
  { pattern: /\b(?:iPhone|iPod)\b/i, label: 'iOS' },
  { pattern: /\bAndroid\b/i, label: 'Android' },
  { pattern: /\bCrOS\b/i, label: 'ChromeOS' },
  { pattern: /\b(?:Mac OS X|Macintosh)\b/i, label: 'macOS' },
  { pattern: /\bWindows\b/i, label: 'Windows' },
  { pattern: /\b(?:Linux|X11)\b/i, label: 'Linux' },
]

const firstMatch = (
  userAgent: string,
  table: readonly { readonly pattern: RegExp; readonly label: string }[]
): string | null => table.find((entry) => entry.pattern.test(userAgent))?.label ?? null

/**
 * A coarse, user-facing device label drawn from a fixed allow-list (requirements 15.5, 15.6).
 *
 * The raw User-Agent is never stored, and no value outside the allow-list can ever be returned —
 * so this cannot become a stored-XSS sink or a fingerprinting vector, and its output is bounded
 * well under {@link DEVICE_LABEL_MAX_LENGTH } by construction (the longest possible result,
 * `'Samsung Internet on ChromeOS'`, is 28 characters). The cap is applied anyway, because a
 * future allow-list entry should be truncated rather than violate the column's contract.
 */
export function deviceLabelFrom(userAgent: string | null | undefined): string {
  if (typeof userAgent !== 'string' || userAgent.trim().length === 0) return UNKNOWN_DEVICE_LABEL

  const browser = firstMatch(userAgent, BROWSER_ALLOW_LIST)
  const os = firstMatch(userAgent, OS_ALLOW_LIST)

  const label =
    browser && os ? `${browser} on ${os}` : (browser ?? os ?? UNKNOWN_DEVICE_LABEL)

  return label.slice(0, DEVICE_LABEL_MAX_LENGTH)
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Refreshes `lastSeenAt`, at most once per hour per device (requirement 7.10).
 *
 * Fire-and-forget and total: it swallows its own failure, because a device list showing a stale
 * "last seen" is immeasurably better than a failed `GET /api/workouts`. The throttle is what
 * keeps the common request read-only — writing on every request would add a write to every data
 * route call.
 */
async function touchLastSeen(
  db: IdentityReadDb,
  deviceId: string,
  lastSeenAt: Date,
  now: number
): Promise<void> {
  if (now - lastSeenAt.getTime() < LAST_SEEN_THROTTLE_MS) return

  try {
    await db.pairedDevice.update({ where: { id: deviceId }, data: { lastSeenAt: new Date(now) } })
  } catch {
    // Deliberately silent: housekeeping must never fail the request it rode in on.
  }
}

/** Reads the device cookie, tolerating a request scope that has no cookie store. */
function readDeviceCookie(): string | null {
  try {
    const value = cookies().get(DEVICE_COOKIE_NAME)?.value
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    // Outside a request scope there is no cookie, which is not an error.
    return null
  }
}

/**
 * The caller's identity: an OAuth account, a paired device, or neither.
 *
 * See the module comment for why the ordering and the three outcomes are what they are. The
 * short version: OAuth first and unconditionally; a cookie second and only when it matches a
 * live row; `database-error` only for connectivity faults (requirements 7.2–7.6).
 */
export async function resolveIdentity(): Promise<IdentityResolution> {
  // 1. OAuth first. With no provider configured this returns `anonymous` without touching the
  //    database, so the common configuration pays nothing for the check.
  const auth = await resolveAuth()
  if (auth.kind === 'database-error') return auth
  if (auth.kind === 'authenticated') {
    return { kind: 'authenticated', userId: auth.userId, source: 'oauth' }
  }

  // 2. The device cookie second — and only now, so a signed-in user with a stale pairing cookie
  //    can never be shown the wrong library.
  const rawToken = readDeviceCookie()
  if (!rawToken) return { kind: 'anonymous' }

  const db: IdentityReadDb | null = getPrismaClient()
  // No database: local-only is a supported state, not a fault.
  if (!db) return { kind: 'anonymous' }

  try {
    const device = await db.pairedDevice.findUnique({
      where: { tokenHash: sha256Hex(rawToken) },
      select: { id: true, lastSeenAt: true, syncSpace: { select: { userId: true } } },
    })

    // Revoked or forged. Silently anonymous: the holder learns nothing, and an unlinked device
    // drops back to local-only on its very next request (requirement 10.6).
    if (!device?.syncSpace) return { kind: 'anonymous' }

    void touchLastSeen(db, device.id, device.lastSeenAt, Date.now())

    return {
      kind: 'authenticated',
      userId: device.syncSpace.userId,
      source: 'paired',
      deviceId: device.id,
    }
  } catch (error) {
    // Never `anonymous` here: a database outage must not present as a sign-out (requirement 7.6).
    return { kind: 'database-error', error }
  }
}

/* -------------------------------------------------------------------------- */
/* Issuing device tokens                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A fresh device token and its digest.
 *
 * SHA-256 rather than bcrypt, deliberately: the preimage is 256 bits of uniform CSPRNG output,
 * so there is no dictionary for a slow KDF to defend against — and the token is verified on
 * every single API request, where ~100ms of key derivation would be indefensible.
 */
function mintToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(DEVICE_TOKEN_BYTES).toString('base64url')
  return { rawToken, tokenHash: sha256Hex(rawToken) }
}

/**
 * Enrols a device into an existing space, returning the raw token for the `Set-Cookie` header
 * (requirements 6.1, 6.2, 6.3).
 *
 * Only the digest is persisted, so a database leak yields no usable credential.
 */
export async function enrolDevice(
  db: IdentityWriteDb,
  spaceId: string,
  label: string
): Promise<DeviceEnrolment> {
  const { rawToken, tokenHash } = mintToken()

  const device = await db.pairedDevice.create({
    data: { syncSpaceId: spaceId, tokenHash, label },
  })

  return { deviceId: device.id, rawToken }
}

/**
 * Creates a whole new identity — shadow `User`, `SyncSpace`, and first `PairedDevice` — in one
 * transaction (requirement 8.1).
 *
 * The shadow user exists because `Workout.userId` and `WorkoutSession.userId` carry a foreign key
 * to `User`: an identity must *be* a `User` row to own records. Creating all three together is
 * what stops a half-built identity — a space with no device, or a user with no space — from
 * surviving a failure partway through.
 */
export async function createSyncSpaceWithDevice(
  db: IdentityDb,
  label: string
): Promise<SpaceCreation> {
  const created = await db.$transaction(async (tx) => {
    const user = await tx.user.create({ data: {} })
    const space = await tx.syncSpace.create({ data: { userId: user.id } })
    const { deviceId, rawToken } = await enrolDevice(tx, space.id, label)

    return { userId: user.id, spaceId: space.id, deviceId, rawToken }
  })

  // The single narrowing this module needs: see the note on `IdentityDb.$transaction`.
  return created as SpaceCreation
}

/**
 * Binds a new `SyncSpace` to a `User` row that already exists (requirement 8.5).
 *
 * The OAuth case. No shadow user is minted, because the caller's `User.id` *is* already the
 * identity that owns their records — creating one would fork their library into a space their
 * account could not see.
 */
export async function createSpaceForExistingUser(
  db: IdentityWriteDb,
  userId: string
): Promise<{ id: string; userId: string }> {
  return db.syncSpace.create({ data: { userId } })
}

/**
 * The `SyncSpace` owned by `userId`, or `null`. Creates nothing.
 *
 * Lives here rather than in each route so that "the caller's space" has exactly one definition —
 * a lookup by the space's unique `userId`, which is identical for a shadow user and for a real
 * OAuth account, and which is therefore the whole of the isolation boundary.
 */
export interface SpaceLookupDb {
  syncSpace: {
    findUnique(args: {
      where: { userId: string }
      select: { id: true; userId: true; rotatedAt: true }
    }): Promise<{ id: string; userId: string; rotatedAt: Date | null } | null>
  }
}

export async function findSpaceForUser(
  db: SpaceLookupDb,
  userId: string
): Promise<{ id: string; userId: string; rotatedAt: Date | null } | null> {
  return db.syncSpace.findUnique({
    where: { userId },
    select: { id: true, userId: true, rotatedAt: true },
  })
}
