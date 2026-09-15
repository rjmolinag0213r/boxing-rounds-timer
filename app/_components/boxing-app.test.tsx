/**
 * The application shell: tab navigation, the viewport-dependent sound-settings surface, and the
 * shared workout list (tasks 12.1, 12.2).
 *
 * The coordination test is the important one here. Before the shared library the builder and
 * the timer each kept their own copy of the saved-workout list and wrote it back whole, so with
 * both mounted behind the tabs a save in one view silently discarded the other's workouts.
 *
 * **Validates: Requirements 10.1, 10.2, 10.9, 10.11**
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import BoxingApp from '@/app/_components/boxing-app'
import { resetWorkoutLibraryForTests } from '@/lib/data/workoutLibrary'

// The toast confirmations of requirement 10.11 are observed through the module, because the
// `<Toaster />` that renders them lives in `app/layout.tsx`, outside every component under test.
const toastMock = vi.hoisted(() => {
  const base = vi.fn()
  return Object.assign(base, {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  })
})

vi.mock('sonner', () => ({ toast: toastMock }))

/** Installs a `matchMedia` stub — jsdom has none — reporting `mobile` for the phone breakpoint. */
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

const tab = (name: RegExp) => screen.getByRole('tab', { name })

/**
 * Activates a tab. Radix switches on `mousedown`, not `click`, so `fireEvent.click` alone
 * leaves the current panel in place.
 */
const selectTab = (name: RegExp): void => {
  fireEvent.mouseDown(tab(name))
}

describe('BoxingApp navigation', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetWorkoutLibraryForTests()
    stubViewport()
    toastMock.mockClear()
    toastMock.success.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('presents Timer, Builder and History tabs with Timer selected', () => {
    render(<BoxingApp />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((element) => element.textContent)).toEqual(['Timer', 'Builder', 'History'])
    // Requirement 10.1.
    expect(tab(/timer/i)).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('timer')).toBeInTheDocument()
  })

  it('styles the active trigger from --primary', () => {
    render(<BoxingApp />)

    // Requirement 10.2: the active state resolves through the primary token, not a literal.
    const timerTab = tab(/timer/i)
    expect(timerTab).toHaveAttribute('data-state', 'active')
    expect(timerTab.className).toContain('data-[state=active]:bg-primary')
    expect(timerTab.className).toContain('data-[state=active]:text-primary-foreground')
  })

  it('renders the builder panel when the Builder tab is activated', async () => {
    render(<BoxingApp />)

    selectTab(/builder/i)

    // Requirement 10.2: activating a tab renders its panel.
    expect(await screen.findByRole('button', { name: /save workout/i })).toBeInTheDocument()
    expect(tab(/builder/i)).toHaveAttribute('aria-selected', 'true')
    expect(tab(/timer/i)).toHaveAttribute('aria-selected', 'false')
  })

  it('renders the history panel when the History tab is activated', async () => {
    render(<BoxingApp />)

    selectTab(/history/i)

    expect(
      await screen.findByRole('button', { name: /refresh workout history/i })
    ).toBeInTheDocument()
  })

  it('keeps the timer panel mounted while another tab is on screen', () => {
    render(<BoxingApp />)

    const timerPanel = screen.getAllByRole('tabpanel', { hidden: true })[0]
    expect(timerPanel).not.toHaveAttribute('hidden')

    selectTab(/history/i)

    // Still in the DOM — a running workout survives a glance at the history — but hidden, so
    // it is out of the accessibility tree.
    expect(timerPanel).toHaveAttribute('hidden')
    expect(timerPanel.querySelector('[role="timer"]')).not.toBeNull()
    expect(screen.queryByRole('timer')).not.toBeInTheDocument()
  })
})

describe('BoxingApp sound settings surface', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetWorkoutLibraryForTests()
    toastMock.mockClear()
  })

  it('opens sound settings as a dialog at 640 px and up', async () => {
    stubViewport({ mobile: false })
    render(<BoxingApp />)

    fireEvent.click(screen.getByRole('button', { name: /sound settings/i }))

    // Requirement 10.2: a centred dialog, not a sheet pinned to the bottom edge.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('data-state', 'open')
    expect(dialog.className).toContain('top-[50%]')
    expect(dialog.className).not.toContain('bottom-0')
    expect(screen.getByRole('switch', { name: /mute all sounds/i })).toBeInTheDocument()
  })

  it('opens sound settings as a bottom-sheet drawer below 640 px', async () => {
    stubViewport({ mobile: true })
    render(<BoxingApp />)

    fireEvent.click(screen.getByRole('button', { name: /sound settings/i }))

    // Requirement 10.2: the same content, pinned to the bottom edge as a sheet.
    const drawer = await screen.findByRole('dialog')
    expect(drawer.className).toContain('bottom-0')
    expect(drawer.className).toContain('rounded-t-')
    expect(drawer.className).not.toContain('top-[50%]')
    expect(screen.getByRole('switch', { name: /mute all sounds/i })).toBeInTheDocument()
  })
})

describe('BoxingApp shared workout list', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetWorkoutLibraryForTests()
    stubViewport()
    toastMock.mockClear()
    toastMock.success.mockClear()
  })

  it('shows a workout saved in the Builder in the Timer’s preset list', async () => {
    render(<BoxingApp />)

    // Let the shared library finish its first load, so the assertion below is about the save
    // and not about a race with it.
    await waitFor(() => {
      expect(screen.getByText('Boxing — Classic 12×3')).toBeInTheDocument()
    })

    selectTab(/builder/i)
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Sparring prep' },
    })
    fireEvent.click(screen.getByRole('button', { name: /save workout/i }))

    // Saving hands the user back to the timer, where the new workout is loadable…
    expect(tab(/timer/i)).toHaveAttribute('aria-selected', 'true')
    expect(
      await screen.findByRole('button', { name: /load sparring prep/i })
    ).toBeInTheDocument()
    // …and the defaults the timer already had are still there: no view clobbered the other.
    expect(screen.getByRole('button', { name: /load boxing — classic 12×3/i })).toBeInTheDocument()

    // Requirement 10.11: the save is confirmed by a transient toast.
    expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('Sparring prep'))
  })

  it('confirms a completed workout with a transient toast', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_700_000_000_000))
    try {
      render(<BoxingApp />)

      // The shortest possible workout: one round, no rest, no lead-in.
      fireEvent.change(screen.getByLabelText('Rounds'), { target: { value: '1' } })
      fireEvent.change(screen.getByLabelText('Round duration minutes'), { target: { value: '0' } })
      fireEvent.change(screen.getByLabelText('Round duration seconds'), { target: { value: '2' } })
      fireEvent.change(screen.getByLabelText('Prep countdown (sec)'), { target: { value: '0' } })

      fireEvent.click(screen.getByRole('button', { name: /start workout/i }))
      vi.advanceTimersByTime(3_000)

      // Requirement 10.11.
      expect(toastMock.success).toHaveBeenCalledWith(
        expect.stringMatching(/workout complete/i),
        expect.anything()
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
