/**
 * Unit tests for the pairing client and the repointed identity probe.
 *
 * Both are thin translation layers, and a translation layer's whole risk is a mis-mapped case:
 * a `429` that surfaces as a generic failure loses the wait time, a `503` that surfaces as an
 * invalid code tells the user to re-type something that was fine, and a probe that treats
 * "sync is not configured" as an error turns a supported deployment into a scary one. So each
 * status gets one assertion, and the probe gets one per way it can be given a useless answer.
 *
 * The status matrix is a finite enumeration rather than an input space, so these are plain
 * assertions — the property tests cover what actually varies with input.
 *
 * Requirements: 4.19, 11.8, 11.11, 13.5, 13.6
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PairingInvalidCodeError,
  PairingLimitError,
  PairingRateLimitedError,
  PairingRequestError,
  PairingUnavailableError,
  claimPairingCode,
  createPairingCode,
  listPairedDevices,
  rotateSyncSpace,
  unlinkDevice,
} from '@/lib/data/pairingClient'

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

interface Recorded {
  url: string
  init: RequestInit
}

/** A `fetch` that answers with one canned response and records what it was asked. */
function stubFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = []

  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init })
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })
  }) as unknown as typeof fetch

  return { fetchImpl, calls }
}

/** A `fetch` that answers `200` with a body that is not JSON at all. */
const nonJsonFetch = (status = 200): typeof fetch =>
  (async () =>
    new Response('<html>gateway</html>', {
      status,
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch

/** A `fetch` that rejects, the way an offline device does. */
const rejectingFetch = (): typeof fetch =>
  (async () => {
    throw new TypeError('Failed to fetch')
  }) as unknown as typeof fetch

/* -------------------------------------------------------------------------- */
/* The happy paths                                                             */
/* -------------------------------------------------------------------------- */

describe('pairingClient success mapping', () => {
  it('reads the 201 code body and sends the device cookie', async () => {
    const { fetchImpl, calls } = stubFetch(201, {
      code: '7KQF-3MTX',
      expiresAt: 1_700_000_600_000,
      ttlMs: 600_000,
      userId: 'usr_1',
      syncAvailable: true,
    })

    const result = await createPairingCode({ fetchImpl })

    expect(result).toEqual({
      code: '7KQF-3MTX',
      expiresAt: 1_700_000_600_000,
      ttlMs: 600_000,
      userId: 'usr_1',
    })
    expect(calls[0].url).toBe('/api/pair/code')
    expect(calls[0].init.method).toBe('POST')
    // Without this the `bx_device` cookie never travels and every paired caller looks anonymous.
    expect(calls[0].init.credentials).toBe('same-origin')
  })

  it('sends the code exactly as typed, leaving normalization to the server', async () => {
    const { fetchImpl, calls } = stubFetch(200, {
      userId: 'usr_1',
      deviceId: 'dev_1',
      spaceId: 'spc_1',
    })

    const result = await claimPairingCode('7kqf 3mtx', { fetchImpl })

    expect(result).toEqual({ userId: 'usr_1', deviceId: 'dev_1', spaceId: 'spc_1' })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ code: '7kqf 3mtx' })
  })

  it('normalizes the device list, defaulting a missing label', async () => {
    const { fetchImpl } = stubFetch(200, {
      devices: [
        { id: 'dev_1', label: 'Chrome on macOS', createdAt: 1, lastSeenAt: 2, isCurrent: true },
        { id: 'dev_2', createdAt: 3, lastSeenAt: 4 },
      ],
      spaceId: 'spc_1',
      rotatedAt: null,
    })

    const result = await listPairedDevices({ fetchImpl })

    expect(result.spaceId).toBe('spc_1')
    expect(result.rotatedAt).toBeNull()
    expect(result.devices).toEqual([
      { id: 'dev_1', label: 'Chrome on macOS', createdAt: 1, lastSeenAt: 2, isCurrent: true },
      { id: 'dev_2', label: 'Unknown device', createdAt: 3, lastSeenAt: 4, isCurrent: false },
    ])
  })

  it('reports whether the unlinked device was the caller\'s own', async () => {
    const { fetchImpl, calls } = stubFetch(200, { id: 'dev_2', wasCurrent: false })

    expect(await unlinkDevice('dev_2', { fetchImpl })).toEqual({
      id: 'dev_2',
      wasCurrent: false,
    })
    expect(calls[0].url).toBe('/api/pair/devices/dev_2')
    expect(calls[0].init.method).toBe('DELETE')
  })

  it('reads the rotation result', async () => {
    const { fetchImpl } = stubFetch(200, {
      userId: 'usr_2',
      spaceId: 'spc_2',
      revokedDevices: 3,
    })

    expect(await rotateSyncSpace({ fetchImpl })).toEqual({
      userId: 'usr_2',
      spaceId: 'spc_2',
      revokedDevices: 3,
    })
  })
})

/* -------------------------------------------------------------------------- */
/* The failure taxonomy                                                        */
/* -------------------------------------------------------------------------- */

describe('pairingClient failure mapping', () => {
  it('maps 400 to PairingInvalidCodeError, carrying the uniform server message', async () => {
    const { fetchImpl } = stubFetch(400, {
      error: 'That code is not valid. Ask for a new one.',
      reason: 'invalid-code',
    })

    await expect(claimPairingCode('AAAAAAAA', { fetchImpl })).rejects.toBeInstanceOf(
      PairingInvalidCodeError
    )
    await expect(claimPairingCode('AAAAAAAA', { fetchImpl })).rejects.toThrow(
      'That code is not valid. Ask for a new one.'
    )
  })

  it('maps 429 to PairingRateLimitedError, reading Retry-After from the header', async () => {
    const { fetchImpl } = stubFetch(
      429,
      { error: 'Too many attempts. Try again shortly.', reason: 'rate-limited' },
      { 'Retry-After': '47' }
    )

    const error = await claimPairingCode('AAAAAAAA', { fetchImpl }).catch((e) => e)

    expect(error).toBeInstanceOf(PairingRateLimitedError)
    expect((error as PairingRateLimitedError).retryAfterSeconds).toBe(47)
  })

  it('falls back to the body Retry-After when the header is absent', async () => {
    // A proxy that strips `Retry-After` must not cost the user the wait time.
    const { fetchImpl } = stubFetch(429, { reason: 'rate-limited', retryAfterSeconds: 12 })

    const error = await claimPairingCode('AAAAAAAA', { fetchImpl }).catch((e) => e)

    expect((error as PairingRateLimitedError).retryAfterSeconds).toBe(12)
  })

  it('never reports a wait below one second', async () => {
    const { fetchImpl } = stubFetch(429, {}, { 'Retry-After': '0' })

    const error = await claimPairingCode('AAAAAAAA', { fetchImpl }).catch((e) => e)

    expect((error as PairingRateLimitedError).retryAfterSeconds).toBe(1)
  })

  it('maps 503 not-configured and 503 unreachable to PairingUnavailableError', async () => {
    const notConfigured = stubFetch(503, {
      error: 'Sync is unavailable',
      reason: 'not-configured',
    })
    const unreachable = stubFetch(503, { error: 'Sync is unavailable', reason: 'unreachable' })

    const first = await createPairingCode({ fetchImpl: notConfigured.fetchImpl }).catch((e) => e)
    const second = await createPairingCode({ fetchImpl: unreachable.fetchImpl }).catch((e) => e)

    expect(first).toBeInstanceOf(PairingUnavailableError)
    expect((first as PairingUnavailableError).reason).toBe('not-configured')
    expect(second).toBeInstanceOf(PairingUnavailableError)
    expect((second as PairingUnavailableError).reason).toBe('unreachable')
  })

  it('maps 409 to PairingLimitError, carrying the server reason', async () => {
    const { fetchImpl } = stubFetch(409, {
      error: 'This sync space is full',
      reason: 'device-limit',
    })

    const error = await claimPairingCode('AAAAAAAA', { fetchImpl }).catch((e) => e)

    expect(error).toBeInstanceOf(PairingLimitError)
    expect((error as PairingLimitError).reason).toBe('device-limit')
  })

  it('maps 401 and 404 to PairingRequestError with the status preserved', async () => {
    const unauthorized = stubFetch(401, { error: 'Not signed in' })
    const notFound = stubFetch(404, { error: 'Device not found' })

    const first = await listPairedDevices({ fetchImpl: unauthorized.fetchImpl }).catch((e) => e)
    const second = await unlinkDevice('dev_9', { fetchImpl: notFound.fetchImpl }).catch((e) => e)

    expect(first).toBeInstanceOf(PairingRequestError)
    expect((first as PairingRequestError).status).toBe(401)
    expect(second).toBeInstanceOf(PairingRequestError)
    expect((second as PairingRequestError).status).toBe(404)
  })

  it('maps any other 5xx to PairingUnavailableError, since it is just as retryable', async () => {
    const { fetchImpl } = stubFetch(502, undefined)

    const error = await rotateSyncSpace({ fetchImpl }).catch((e) => e)

    expect(error).toBeInstanceOf(PairingUnavailableError)
    expect((error as PairingUnavailableError).status).toBe(502)
  })

  it('maps a rejected fetch to PairingUnavailableError and queues nothing', async () => {
    // Requirement 13.6: pairing is an interactive act, so a failure is reported and dropped
    // rather than retried behind the user's back.
    const fetchImpl = rejectingFetch()

    const error = await claimPairingCode('AAAAAAAA', { fetchImpl }).catch((e) => e)

    expect(error).toBeInstanceOf(PairingUnavailableError)
    expect((error as PairingUnavailableError).reason).toBe('offline')

    // A second attempt issues exactly one more request: nothing was queued from the first.
    let calls = 0
    const counting = (async () => {
      calls += 1
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    await claimPairingCode('AAAAAAAA', { fetchImpl: counting }).catch(() => undefined)
    expect(calls).toBe(1)
  })

  it('tolerates a non-JSON success body rather than throwing', async () => {
    // A gateway's HTML page on an otherwise-200 response must not become an unhandled parse
    // error; the fields simply come back empty and the caller sees no identity.
    const result = await createPairingCode({ fetchImpl: nonJsonFetch(201) })

    expect(result.code).toBe('')
    expect(result.userId).toBe('')
  })

  it('still classifies a non-JSON error body by its status', async () => {
    const error = await createPairingCode({ fetchImpl: nonJsonFetch(503) }).catch((e) => e)

    expect(error).toBeInstanceOf(PairingUnavailableError)
  })
})

/* -------------------------------------------------------------------------- */
/* The identity probe                                                          */
/* -------------------------------------------------------------------------- */

describe('repositoryClient identity probe', () => {
  const originalFetch = globalThis.fetch

  /** Installs a `fetch` answering `/api/pair/identity` with `body` at `status`. */
  const useIdentityResponse = (status: number, body: unknown, contentType = 'application/json') => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(
        typeof body === 'string' ? body : body === undefined ? null : JSON.stringify(body),
        { status, headers: { 'content-type': contentType } }
      )
    }) as unknown as typeof fetch
    return calls
  }

  beforeEach(async () => {
    vi.resetModules()
    window.localStorage.clear()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('probes /api/pair/identity, not /api/auth/session', async () => {
    const calls = useIdentityResponse(200, {
      kind: 'anonymous',
      userId: null,
      deviceId: null,
      syncAvailable: true,
    })

    const client = await import('@/lib/data/repositoryClient')
    client.resetWorkoutRepositoryForTests()
    await client.whenSessionResolved()

    expect(calls).toEqual(['/api/pair/identity'])
  })

  it('records sync as unavailable and stays local-only on syncAvailable: false', async () => {
    useIdentityResponse(200, {
      kind: 'anonymous',
      userId: null,
      deviceId: null,
      syncAvailable: false,
    })

    const client = await import('@/lib/data/repositoryClient')
    client.resetWorkoutRepositoryForTests()

    const seen: boolean[] = []
    client.subscribeSyncAvailability((available) => seen.push(available))
    await client.whenSessionResolved()

    expect(client.getSyncAvailability()).toBe(false)
    expect(seen).toEqual([false])
    expect(client.getWorkoutRepository().getState().mode).toBe('local-only')
  })

  it('adopts a paired identity and records the source', async () => {
    useIdentityResponse(200, {
      kind: 'paired',
      userId: 'usr_1',
      deviceId: 'dev_1',
      syncAvailable: true,
    })

    const client = await import('@/lib/data/repositoryClient')
    client.resetWorkoutRepositoryForTests()
    await client.whenSessionResolved()

    const state = client.getWorkoutRepository().getState()
    expect(client.getSyncAvailability()).toBe(true)
    expect(state.mode).toBe('authenticated')
    expect(state.userId).toBe('usr_1')
    expect(state.source).toBe('paired')
  })

  it('records source oauth for an OAuth identity', async () => {
    useIdentityResponse(200, {
      kind: 'oauth',
      userId: 'usr_oauth',
      deviceId: null,
      syncAvailable: true,
    })

    const client = await import('@/lib/data/repositoryClient')
    client.resetWorkoutRepositoryForTests()
    await client.whenSessionResolved()

    expect(client.getWorkoutRepository().getState().source).toBe('oauth')
  })

  it('stays local-only on a non-JSON body', async () => {
    useIdentityResponse(200, '<html>gateway</html>', 'text/html')

    const client = await import('@/lib/data/repositoryClient')
    client.resetWorkoutRepositoryForTests()
    await client.whenSessionResolved()

    expect(client.getWorkoutRepository().getState().mode).toBe('local-only')
  })

  it('stays local-only when the probe rejects', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    const client = await import('@/lib/data/repositoryClient')
    client.resetWorkoutRepositoryForTests()
    await client.whenSessionResolved()

    expect(client.getWorkoutRepository().getState().mode).toBe('local-only')
    // Availability stays *unknown* rather than false: a failed probe is not evidence that the
    // deployment cannot sync, and claiming it is would show the wrong explanation.
    expect(client.getSyncAvailability()).toBeNull()
  })

  it('re-runs the probe on refreshIdentity, picking up a new identity', async () => {
    // Only the identity requests are counted: adopting an identity also triggers the existing
    // reconcile, whose own `/api/workouts` and `/api/sessions` calls are not what is under test.
    let identityCalls = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url !== '/api/pair/identity') {
        return new Response(JSON.stringify({ workouts: [], sessions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      identityCalls += 1
      const body =
        identityCalls === 1
          ? { kind: 'anonymous', userId: null, deviceId: null, syncAvailable: true }
          : { kind: 'paired', userId: 'usr_after_pair', deviceId: 'dev_1', syncAvailable: true }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const client = await import('@/lib/data/repositoryClient')
    client.resetWorkoutRepositoryForTests()
    await client.whenSessionResolved()
    expect(client.getWorkoutRepository().getState().userId).toBeNull()

    await client.refreshIdentity()

    expect(identityCalls).toBe(2)
    expect(client.getWorkoutRepository().getState().userId).toBe('usr_after_pair')
  })

  it('drops back to local-only when the identity is gone (a revoked device)', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      const body =
        calls === 1
          ? { kind: 'paired', userId: 'usr_1', deviceId: 'dev_1', syncAvailable: true }
          : { kind: 'anonymous', userId: null, deviceId: null, syncAvailable: true }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const client = await import('@/lib/data/repositoryClient')
    client.resetWorkoutRepositoryForTests()
    await client.whenSessionResolved()
    expect(client.getWorkoutRepository().getState().userId).toBe('usr_1')

    // Requirement 10.7: the row was deleted elsewhere, so this device resolves anonymous again
    // and continues locally rather than showing an error.
    await client.refreshIdentity()

    const state = client.getWorkoutRepository().getState()
    expect(state.mode).toBe('local-only')
    expect(state.userId).toBeNull()
    expect(state.source).toBeUndefined()
  })

  it('stays local-only when the probe answers a non-OK status', async () => {
    useIdentityResponse(500, { error: 'boom' })

    const client = await import('@/lib/data/repositoryClient')
    client.resetWorkoutRepositoryForTests()
    await client.whenSessionResolved()

    expect(client.getWorkoutRepository().getState().mode).toBe('local-only')
    expect(client.getSyncAvailability()).toBeNull()
  })
})
