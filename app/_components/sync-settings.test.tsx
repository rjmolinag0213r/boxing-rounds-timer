/**
 * Component tests for the Sync surface.
 *
 * Three of these are the ones worth having. The **countdown** is the only place in the app that
 * derives a ticking value from a held timestamp, and the accessible shape of that region is
 * load-bearing: a polite live region on a per-second counter would produce hundreds of
 * announcements per code. The **uniform failure message** is a security property wearing a UI
 * costume — the panel must repeat what the server said and add nothing. And the **unlink
 * buttons** must be individually nameable, or a screen-reader user hears "Unlink" once per row
 * with no way to tell the rows apart.
 *
 * The pairing client and the repository client are mocked at the module boundary: this file is
 * about what the panel renders and announces, and both of those are covered directly elsewhere.
 *
 * **Validates: Requirements 12.2, 12.5, 12.6, 12.7, 12.10, 12.11, 12.14, 12.18, 12.19**
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PairedDeviceInfo } from '@/lib/data/pairingClient'
import type { SyncState } from '@/lib/data/workoutRepository'

/* -------------------------------------------------------------------------- */
/* Module doubles                                                              */
/* -------------------------------------------------------------------------- */

const pairing = vi.hoisted(() => ({
  createPairingCode: vi.fn(),
  claimPairingCode: vi.fn(),
  listPairedDevices: vi.fn(),
  unlinkDevice: vi.fn(),
  rotateSyncSpace: vi.fn(),
}))

const repositoryClient = vi.hoisted(() => ({
  getSyncAvailability: vi.fn(),
  subscribeSyncAvailability: vi.fn(),
  getWorkoutRepository: vi.fn(),
  refreshIdentity: vi.fn(),
}))

vi.mock('@/lib/data/pairingClient', async () => {
  // The error classes are real: the panel branches on `instanceof`, so stubbing them would
  // test a different program.
  const actual = await vi.importActual<typeof import('@/lib/data/pairingClient')>(
    '@/lib/data/pairingClient'
  )
  return { ...actual, ...pairing }
})

vi.mock('@/lib/data/repositoryClient', () => repositoryClient)

const { PairingInvalidCodeError, PairingUnavailableError } = await import(
  '@/lib/data/pairingClient'
)
const SyncSettings = (await import('@/app/_components/sync-settings')).default

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** jsdom implements no `matchMedia`; this is the narrowest stub the motion hook needs. */
function stubViewport(options: { mobile?: boolean; reducedMotion?: boolean } = {}): void {
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: query.includes('max-width')
      ? options.mobile === true
      : query.includes('prefers-reduced-motion')
        ? options.reducedMotion === true
        : false,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

const localOnly: SyncState = {
  mode: 'local-only',
  userId: null,
  synchronized: true,
  pendingCount: 0,
  lastError: null,
}

const authenticated = (overrides: Partial<SyncState> = {}): SyncState => ({
  mode: 'authenticated',
  userId: 'usr_1',
  synchronized: true,
  pendingCount: 0,
  lastError: null,
  source: 'paired',
  ...overrides,
})

const retryPending = vi.fn()

/** A repository stand-in publishing one fixed state. */
function useRepository(state: SyncState): void {
  repositoryClient.getWorkoutRepository.mockReturnValue({
    getState: () => state,
    subscribe: () => () => {},
    retryPending,
  })
}

/** Installs the availability answer, plus the no-op subscription the panel registers. */
function useAvailability(available: boolean | null): void {
  repositoryClient.getSyncAvailability.mockReturnValue(available)
  repositoryClient.subscribeSyncAvailability.mockReturnValue(() => {})
}

const device = (overrides: Partial<PairedDeviceInfo> = {}): PairedDeviceInfo => ({
  id: 'dev_1',
  label: 'Chrome on macOS',
  createdAt: 1_700_000_000_000,
  lastSeenAt: Date.now() - 60_000,
  isCurrent: false,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  stubViewport()
  useAvailability(true)
  useRepository(localOnly)
  repositoryClient.refreshIdentity.mockResolvedValue(undefined)
  pairing.listPairedDevices.mockResolvedValue({ devices: [], spaceId: null, rotatedAt: null })
})

afterEach(() => {
  vi.useRealTimers()
})

/* -------------------------------------------------------------------------- */
/* Section order and status                                                    */
/* -------------------------------------------------------------------------- */

describe('SyncSettings structure', () => {
  it('presents the five sections in the required order', () => {
    // Requirement 12.4.
    render(<SyncSettings />)

    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(headings).toEqual([
      'Status',
      'Link another device',
      'Enter a code',
      'Paired devices',
      'Rotate sync space',
    ])
  })

  it('states that pairing merges before the user can submit a code', () => {
    // Requirement 9.9: the merge is not reversible from here, so it is named up front.
    render(<SyncSettings />)

    expect(screen.getByText(/merges this device's workouts and history/i)).toBeInTheDocument()
  })

  it('shows the pending count and a control that calls retryPending', () => {
    // Requirement 11.6.
    useRepository(authenticated({ synchronized: false, pendingCount: 3 }))
    render(<SyncSettings />)

    expect(screen.getByText('3 changes waiting to sync.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /retry now/i }))
    expect(retryPending).toHaveBeenCalledTimes(1)
  })

  it('replaces every pairing control with one muted explanation when sync is unavailable', () => {
    // Requirement 12.19: a deployment with no database is working as designed, not broken.
    useAvailability(false)
    render(<SyncSettings />)

    const explanations = screen.getAllByTestId('sync-unavailable')
    expect(explanations).toHaveLength(1)
    expect(explanations[0].className).toContain('text-muted-foreground')
    expect(screen.queryByRole('button', { name: /generate a code/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /rotate sync space/i })).not.toBeInTheDocument()
  })
})

/* -------------------------------------------------------------------------- */
/* The countdown                                                               */
/* -------------------------------------------------------------------------- */

describe('SyncSettings live code countdown', () => {
  const generateCode = async (ttlMs = 600_000): Promise<void> => {
    pairing.createPairingCode.mockResolvedValue({
      code: '7KQF-3MTX',
      expiresAt: Date.now() + ttlMs,
      ttlMs,
      userId: 'usr_1',
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /generate a code/i }))
    })
  }

  it('renders the code grouped XXXX-XXXX with a decreasing countdown and no polling', async () => {
    // Requirements 12.5, 12.8.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<SyncSettings />)
    await generateCode()

    expect(screen.getByText('7KQF-3MTX')).toBeInTheDocument()
    const countdown = screen.getByTestId('sync-code-countdown')
    expect(countdown.textContent).toBe('Expires in 10:00')

    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(screen.getByTestId('sync-code-countdown').textContent).toBe('Expires in 9:55')

    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByTestId('sync-code-countdown').textContent).toBe('Expires in 8:55')

    // The whole point of holding `expiresAt`: the ticking costs no requests.
    expect(pairing.createPairingCode).toHaveBeenCalledTimes(1)
  })

  it('gives the countdown role="timer" and aria-live="off"', async () => {
    // Requirement 12.6: hundreds of polite announcements would make the panel unusable.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<SyncSettings />)
    await generateCode()

    const countdown = screen.getByTestId('sync-code-countdown')
    expect(countdown).toHaveAttribute('role', 'timer')
    expect(countdown).toHaveAttribute('aria-live', 'off')
  })

  it('announces politely exactly once at expiry and offers a fresh code', async () => {
    // Requirement 12.7.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<SyncSettings />)

    const announcement = screen.getByTestId('sync-code-announcement')
    expect(announcement).toHaveAttribute('aria-live', 'polite')
    expect(announcement.className).toContain('sr-only')

    await generateCode(30_000)
    // Silent while the code is alive.
    expect(screen.getByTestId('sync-code-announcement').textContent).toBe('')

    await act(async () => {
      vi.advanceTimersByTime(31_000)
    })

    expect(screen.getByTestId('sync-code-announcement').textContent).toBe(
      'Pairing code expired. Generate a new one.'
    )
    // Exactly one polite region in the whole panel, so there is exactly one announcement.
    expect(
      document.querySelectorAll('[aria-live="polite"]:not([role="timer"])')
    ).toHaveLength(1)

    // The code is replaced by a control that mints a new one.
    expect(screen.queryByText('7KQF-3MTX')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /generate a new code/i })).toBeInTheDocument()
  })
})

/* -------------------------------------------------------------------------- */
/* Claiming                                                                    */
/* -------------------------------------------------------------------------- */

describe('SyncSettings code entry', () => {
  /** The single hidden input `input-otp` renders behind the eight slots. */
  const codeInput = (): HTMLInputElement =>
    screen.getByLabelText(/pairing code from your other device/i) as HTMLInputElement

  it('offers eight slots grouped four and four, and submits on the eighth character', async () => {
    // Requirements 12.9, 12.20.
    pairing.claimPairingCode.mockResolvedValue({
      userId: 'usr_1',
      deviceId: 'dev_1',
      spaceId: 'spc_1',
    })
    render(<SyncSettings />)

    expect(codeInput()).toHaveAttribute('maxlength', '8')

    await act(async () => {
      fireEvent.change(codeInput(), { target: { value: '7kqf3mtx' } })
    })

    // Upper-cased for display; the raw entry is what travels, because the server owns
    // normalization.
    await waitFor(() => expect(pairing.claimPairingCode).toHaveBeenCalledTimes(1))
    expect(pairing.claimPairingCode).toHaveBeenCalledWith('7KQF3MTX')
  })

  it('renders the server\'s uniform failure message in a role="alert" region, unelaborated', async () => {
    // Requirements 5.8, 12.10: adding a more specific reason would leak the oracle the server
    // deliberately withholds.
    const uniform = 'That code is not valid. Ask for a new one.'
    pairing.claimPairingCode.mockRejectedValue(new PairingInvalidCodeError(uniform))
    render(<SyncSettings />)

    await act(async () => {
      fireEvent.change(codeInput(), { target: { value: 'AAAABBBB' } })
    })

    const alert = await screen.findByTestId('sync-claim-status')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert.textContent).toBe(uniform)
    // No reason beyond the server's own sentence.
    expect(alert.textContent).not.toMatch(/expired|consumed|already used|unknown/i)
  })

  it('says pairing needs a connection when the device is offline', async () => {
    // Requirement 13.5.
    pairing.claimPairingCode.mockRejectedValue(
      new PairingUnavailableError('offline', 'offline')
    )
    render(<SyncSettings />)

    await act(async () => {
      fireEvent.change(codeInput(), { target: { value: 'AAAABBBB' } })
    })

    expect((await screen.findByTestId('sync-claim-status')).textContent).toMatch(
      /pairing needs a connection/i
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Devices, unlink and rotate                                                  */
/* -------------------------------------------------------------------------- */

describe('SyncSettings device list', () => {
  beforeEach(() => {
    useRepository(authenticated())
  })

  it('lists each device with a relative last-seen time and a uniquely named unlink control', async () => {
    // Requirement 12.11.
    pairing.listPairedDevices.mockResolvedValue({
      devices: [
        device({ id: 'dev_1', label: 'Chrome on macOS', isCurrent: true }),
        device({ id: 'dev_2', label: 'Safari on iOS', lastSeenAt: Date.now() - 7_200_000 }),
      ],
      spaceId: 'spc_1',
      rotatedAt: null,
    })

    render(<SyncSettings />)

    const first = await screen.findByRole('button', { name: 'Unlink Chrome on macOS' })
    const second = screen.getByRole('button', { name: 'Unlink Safari on iOS' })
    expect(first).not.toBe(second)

    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]).getByText(/This device ·/)).toBeInTheDocument()
    expect(within(rows[1]).getByText(/hours ago/)).toBeInTheDocument()
  })

  it('unlinks another device immediately, and the current device only after confirmation', async () => {
    // Requirement 12.12.
    pairing.listPairedDevices.mockResolvedValue({
      devices: [
        device({ id: 'dev_1', label: 'Chrome on macOS', isCurrent: true }),
        device({ id: 'dev_2', label: 'Safari on iOS' }),
      ],
      spaceId: 'spc_1',
      rotatedAt: null,
    })
    pairing.unlinkDevice.mockResolvedValue({ id: 'dev_2', wasCurrent: false })

    render(<SyncSettings />)

    // Another device: no confirmation needed.
    const other = await screen.findByRole('button', { name: 'Unlink Safari on iOS' })
    await act(async () => {
      fireEvent.click(other)
    })
    expect(pairing.unlinkDevice).toHaveBeenCalledWith('dev_2')

    // This device: an AlertDialog stands in the way.
    pairing.unlinkDevice.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Chrome on macOS' }))

    const confirmation = await screen.findByRole('alertdialog')
    expect(pairing.unlinkDevice).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(within(confirmation).getByRole('button', { name: /unlink this device/i }))
    })
    expect(pairing.unlinkDevice).toHaveBeenCalledWith('dev_1')
  })

  it('confirms rotation with copy naming both consequences', async () => {
    // Requirement 12.13.
    render(<SyncSettings />)

    fireEvent.click(screen.getByRole('button', { name: /^rotate sync space$/i }))

    const confirmation = await screen.findByRole('alertdialog')
    const copy = confirmation.textContent ?? ''
    expect(copy).toMatch(/unlinks every device/i)
    expect(copy).toMatch(/workouts and history move with you/i)
  })
})

/* -------------------------------------------------------------------------- */
/* The 44 pixel convention                                                     */
/* -------------------------------------------------------------------------- */

describe('SyncSettings touch targets', () => {
  it('gives every interactive element at least 44 pixels of height', async () => {
    // Requirement 12.14.
    useRepository(authenticated({ synchronized: false, pendingCount: 2 }))
    pairing.listPairedDevices.mockResolvedValue({
      devices: [device({ id: 'dev_1', label: 'Chrome on macOS' })],
      spaceId: 'spc_1',
      rotatedAt: null,
    })

    render(<SyncSettings />)
    await screen.findByRole('button', { name: 'Unlink Chrome on macOS' })

    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect(button.className, button.textContent ?? '').toContain('min-h-[44px]')
    }

    // The eight code slots are thumb-sized too, so the control can be tapped accurately.
    const slots = document.querySelectorAll('[class*="min-h-\\[44px\\]"]')
    expect(slots.length).toBeGreaterThanOrEqual(8)
  })

  it('expresses focus through the --ring convention', () => {
    // Requirement 12.16.
    render(<SyncSettings />)

    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('focus-visible:ring-ring')
    }
  })
})
