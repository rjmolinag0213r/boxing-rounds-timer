'use client'

/**
 * The typed fetch wrapper over the pairing endpoints.
 *
 * Pairing is a **deliberate interactive act**, which is the one way it differs from the data
 * writes in `workoutRepository.ts`: a workout the server rejected is kept locally and retried
 * on the next successful request, but a pairing attempt that failed is simply reported and
 * dropped. Queueing it would mean silently claiming a code minutes later, possibly after the
 * user typed a different one — so a failed attempt requires a fresh user action (requirement
 * 13.6).
 *
 * The error taxonomy deliberately mirrors `RemoteUnavailableError` and friends, so the Sync
 * panel's failure handling reads like the rest of the app:
 *
 * - `PairingRateLimitedError` — `429`, carrying the server's `Retry-After` in whole seconds.
 * - `PairingInvalidCodeError` — `400`, carrying the server's *single uniform* message. The
 *   client must not invent a more specific reason, because it does not have one: absent,
 *   expired, consumed and malformed all answer identically by design (requirement 5.x).
 * - `PairingUnavailableError` — `503` (no `DATABASE_URL`, or configured-but-unreachable) and a
 *   rejected `fetch` (offline). Local-only is a supported state, not a fault.
 * - `PairingLimitError` — `409`, the device cap or the live-code cap.
 * - `PairingRequestError` — any other non-OK status (`401`, `404`, …).
 *
 * Every request sends `credentials: 'same-origin'` so the `bx_device` cookie travels; without
 * it a cross-origin-defaulting fetch would drop the cookie and every paired caller would look
 * anonymous.
 *
 * Requirements: 4.19, 9.3, 13.5, 13.6
 */

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

export interface PairingCodeResult {
  /** Already grouped `XXXX-XXXX` by the server; presentational only. */
  code: string
  /** Epoch milliseconds. The client owns the countdown from here — no polling. */
  expiresAt: number
  ttlMs: number
  userId: string
}

export interface ClaimResult {
  userId: string
  deviceId: string
  spaceId: string
}

export interface PairedDeviceInfo {
  id: string
  label: string
  createdAt: number
  lastSeenAt: number
  isCurrent: boolean
}

export interface PairedDeviceList {
  devices: PairedDeviceInfo[]
  /** `null` for a caller who resolves to an identity but owns no space yet. */
  spaceId: string | null
  rotatedAt: number | null
}

export interface UnlinkResult {
  id: string
  wasCurrent: boolean
}

export interface RotateResult {
  userId: string
  spaceId: string
  revokedDevices: number
}

/* -------------------------------------------------------------------------- */
/* Failure taxonomy                                                            */
/* -------------------------------------------------------------------------- */

/** `429`. `retryAfterSeconds` is always at least 1, so a caller can always show a wait. */
export class PairingRateLimitedError extends Error {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number, message = 'Too many attempts. Try again shortly.') {
    super(message)
    this.name = 'PairingRateLimitedError'
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds))
  }
}

/** `400` — the one uniform claim rejection. Carries the server's message verbatim. */
export class PairingInvalidCodeError extends Error {
  constructor(message = 'That code is not valid. Ask for a new one.') {
    super(message)
    this.name = 'PairingInvalidCodeError'
  }
}

/** `503`, or an outright network failure. Sync is off; everything local keeps working. */
export class PairingUnavailableError extends Error {
  readonly status?: number
  /** `not-configured` (no `DATABASE_URL`), `unreachable`, or `offline` for a failed fetch. */
  readonly reason: 'not-configured' | 'unreachable' | 'offline'

  constructor(
    message: string,
    reason: 'not-configured' | 'unreachable' | 'offline' = 'unreachable',
    status?: number,
    cause?: unknown
  ) {
    super(message)
    this.name = 'PairingUnavailableError'
    this.reason = reason
    this.status = status
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

/** `409` — the space already holds 10 devices, or 3 live codes. */
export class PairingLimitError extends Error {
  /** `device-limit` or `code-limit`, as reported by the server. */
  readonly reason: string

  constructor(message: string, reason = 'limit') {
    super(message)
    this.name = 'PairingLimitError'
    this.reason = reason
  }
}

/** Any other non-OK status: `401` (not paired), `404` (unknown device), and so on. */
export class PairingRequestError extends Error {
  readonly status: number

  constructor(status: number, message = `Pairing request failed with status ${status}`) {
    super(message)
    this.name = 'PairingRequestError'
    this.status = status
  }
}

/* -------------------------------------------------------------------------- */
/* The transport                                                               */
/* -------------------------------------------------------------------------- */

export interface PairingClientOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Prefixed to every path. Empty in the browser. */
  baseUrl?: string
}

type Json = Record<string, unknown> | undefined

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

async function safeJson(response: Response): Promise<Json> {
  try {
    return (await response.json()) as Json
  } catch {
    // A proxy's HTML error page, or an empty body. The status alone drives the taxonomy.
    return undefined
  }
}

/**
 * Reads `Retry-After` from the header first and the body second.
 *
 * The header is the authoritative wire contract (and the one a proxy would preserve); the body
 * copy is a convenience the route also emits. Either way the floor is 1 second, so "wait 0s"
 * can never be shown.
 */
function retryAfterFrom(response: Response, body: Json): number {
  const header = response.headers.get('Retry-After')
  const fromHeader = header === null ? Number.NaN : Number(header)
  if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader

  const fromBody = asNumber(body?.retryAfterSeconds, Number.NaN)
  return Number.isFinite(fromBody) && fromBody > 0 ? fromBody : 1
}

function resolveFetch(options: PairingClientOptions): typeof fetch {
  const injected = options.fetchImpl
  if (injected) return injected
  return (input, init) => {
    if (typeof fetch !== 'function') {
      return Promise.reject(new PairingUnavailableError('No fetch available', 'offline'))
    }
    return fetch(input, init)
  }
}

/**
 * One request, one taxonomy translation.
 *
 * The status ladder is ordered most-specific-first so that a `503` is never mistaken for the
 * generic 5xx case and a `429` never falls through to `PairingRequestError`.
 */
async function request(
  path: string,
  init: RequestInit,
  options: PairingClientOptions
): Promise<Json> {
  const fetchImpl = resolveFetch(options)
  const url = `${options.baseUrl ?? ''}${path}`

  let response: Response
  try {
    response = await fetchImpl(url, {
      ...init,
      // Without this the device cookie is not sent and every paired caller looks anonymous.
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
    })
  } catch (error) {
    if (error instanceof PairingUnavailableError) throw error
    throw new PairingUnavailableError(
      'Pairing needs a connection. Everything else keeps working.',
      'offline',
      undefined,
      error
    )
  }

  if (response.ok) return safeJson(response)

  const body = await safeJson(response)
  const message = asString(body?.error)

  if (response.status === 429) {
    throw new PairingRateLimitedError(
      retryAfterFrom(response, body),
      message || 'Too many attempts. Try again shortly.'
    )
  }

  if (response.status === 503) {
    const reason = asString(body?.reason) === 'not-configured' ? 'not-configured' : 'unreachable'
    throw new PairingUnavailableError(
      message || 'Sync is unavailable. Your data stays on this device.',
      reason,
      503
    )
  }

  if (response.status === 409) {
    throw new PairingLimitError(
      message || 'That limit has been reached.',
      asString(body?.reason, 'limit')
    )
  }

  if (response.status === 400) {
    throw new PairingInvalidCodeError(message || undefined)
  }

  // Any other 5xx is as retryable as a 503, and just as much "not your fault".
  if (response.status >= 500) {
    throw new PairingUnavailableError(
      message || `Sync is unavailable (${response.status}).`,
      'unreachable',
      response.status
    )
  }

  throw new PairingRequestError(response.status, message || undefined)
}

/* -------------------------------------------------------------------------- */
/* The five operations                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Mints a code in the caller's sync space, creating the space (and this device) if the caller
 * was anonymous. The `201` body is the only place the plaintext code ever appears.
 */
export async function createPairingCode(
  options: PairingClientOptions = {}
): Promise<PairingCodeResult> {
  const body = await request('/api/pair/code', { method: 'POST' }, options)

  return {
    code: asString(body?.code),
    expiresAt: asNumber(body?.expiresAt),
    ttlMs: asNumber(body?.ttlMs),
    userId: asString(body?.userId),
  }
}

/**
 * Claims a code, joining its sync space.
 *
 * The raw entry is sent as typed: normalization is the server's job (requirement 12.20), and
 * a client that pre-normalized would be trusted with a decision it must not own.
 */
export async function claimPairingCode(
  code: string,
  options: PairingClientOptions = {}
): Promise<ClaimResult> {
  const body = await request(
    '/api/pair/claim',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    },
    options
  )

  return {
    userId: asString(body?.userId),
    deviceId: asString(body?.deviceId),
    spaceId: asString(body?.spaceId),
  }
}

/** Lists the caller's own sync space devices. `401` surfaces as `PairingRequestError`. */
export async function listPairedDevices(
  options: PairingClientOptions = {}
): Promise<PairedDeviceList> {
  const body = await request('/api/pair/devices', { method: 'GET' }, options)
  const rows = Array.isArray(body?.devices)
    ? (body!.devices as Record<string, unknown>[])
    : []

  return {
    devices: rows.map((row) => ({
      id: asString(row.id),
      label: asString(row.label, 'Unknown device'),
      createdAt: asNumber(row.createdAt),
      lastSeenAt: asNumber(row.lastSeenAt),
      isCurrent: row.isCurrent === true,
    })),
    spaceId: typeof body?.spaceId === 'string' ? (body.spaceId as string) : null,
    rotatedAt: typeof body?.rotatedAt === 'number' ? (body.rotatedAt as number) : null,
  }
}

/** Unlinks one device. An unknown id and another space's id both answer `404`, identically. */
export async function unlinkDevice(
  id: string,
  options: PairingClientOptions = {}
): Promise<UnlinkResult> {
  const body = await request(
    `/api/pair/devices/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    options
  )

  return { id: asString(body?.id, id), wasCurrent: body?.wasCurrent === true }
}

/** Rotates the sync space: every device is unlinked, and the caller's records move with them. */
export async function rotateSyncSpace(
  options: PairingClientOptions = {}
): Promise<RotateResult> {
  const body = await request('/api/pair/rotate', { method: 'POST' }, options)

  return {
    userId: asString(body?.userId),
    spaceId: asString(body?.spaceId),
    revokedDevices: asNumber(body?.revokedDevices),
  }
}
