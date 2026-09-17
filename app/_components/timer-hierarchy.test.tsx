/**
 * The active/idle distinction in the timer panel.
 *
 * The panel is read mid-workout, from three to six feet away, in glances of well under a
 * second. These tests pin the four behaviours that makes possible, all of which the previous
 * layout got wrong:
 *
 * - **The round counter is a first-class element while a workout is on screen.** It used to be
 *   11 px of grey in the panel's top-right corner while three separate elements said "ready".
 * - **Colour is the primary work/rest signal.** Each phase paints a filled banner from a paired
 *   colour token, not a thin ring outline, and work and rest never resolve to the same fill.
 * - **No dead controls.** Every rendered control does something in the phase it appears in.
 * - **The background-audio note is disclosed, not permanent.** The text is preserved in full
 *   and reachable from every phase — it just no longer occupies prime real estate by default.
 *
 * **Validates: Requirements 4.6, 9.11, 10.3, 10.4, 10.5**
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import BoxingTimer from '@/app/_components/boxing-timer'
import { resetWorkoutLibraryForTests } from '@/lib/data/workoutLibrary'

/** jsdom implements no `matchMedia`; this is the narrowest stub the view's hooks need. */
function stubViewport(options: { mobile?: boolean } = {}): void {
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: query.includes('max-width') ? options.mobile === true : false,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

/**
 * Tailwind's type scale in CSS pixels. Tailwind is not compiled in this environment, so the
 * utility class is the only evidence of a rendered size available — and it *is* the CSS
 * Tailwind emits, which is what "prominent" has to be measured against.
 */
const TEXT_SIZE_PX: Readonly<Record<string, number>> = {
  'text-xs': 12,
  'text-sm': 14,
  'text-base': 16,
  'text-lg': 18,
  'text-xl': 20,
  'text-2xl': 24,
  'text-3xl': 30,
  'text-4xl': 36,
  'text-5xl': 48,
  'text-6xl': 60,
  'text-7xl': 72,
  'text-8xl': 96,
}

/** The unprefixed (i.e. mobile) font size an element declares, in CSS pixels. */
function baseFontSizePx(element: HTMLElement): number | null {
  for (const token of (element.getAttribute('class') ?? '').split(/\s+/)) {
    // Skip breakpoint- and state-prefixed variants: the phone is the case under test.
    if (token.includes(':')) continue
    if (token in TEXT_SIZE_PX) return TEXT_SIZE_PX[token]
  }
  return null
}

const startWorkout = (): void => {
  fireEvent.click(screen.getByRole('button', { name: /start workout/i }))
}

/** Sets the configuration through the side panel (mounted at 640 px and up). */
function configure(options: { rounds: number; roundSeconds: number; prepSeconds: number }): void {
  fireEvent.change(screen.getByLabelText('Rounds'), { target: { value: String(options.rounds) } })
  fireEvent.change(screen.getByLabelText('Round duration minutes'), { target: { value: '0' } })
  fireEvent.change(screen.getByLabelText('Round duration seconds'), {
    target: { value: String(options.roundSeconds) },
  })
  fireEvent.change(screen.getByLabelText('Prep countdown (sec)'), {
    target: { value: String(options.prepSeconds) },
  })
}

const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/** The phase banner — the filled block carrying the phase word and the round counter. */
const banner = (): HTMLElement => screen.getByRole('status')

beforeEach(() => {
  window.localStorage.clear()
  resetWorkoutLibraryForTests()
  stubViewport()
})

/* -------------------------------------------------------------------------- */
/* The round counter, while running                                            */
/* -------------------------------------------------------------------------- */

describe('the round indicator while a workout is running', () => {
  it('is rendered in the phase banner at a glanceable size, not as 11 px of grey', () => {
    render(<BoxingTimer />)

    // Idle: no banner at all, so the panel is not claiming a phase it is not in.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    startWorkout()

    const roundCounter = within(banner()).getByText('1')
    // "Round 1 / 12" — the number and its total, in the banner.
    expect(roundCounter.parentElement?.textContent).toMatch(/Round\s*1\s*\/\s*12/)

    // At least text-xl (20 px). The old indicator was text-xs (12 px).
    expect(baseFontSizePx(roundCounter)).toBeGreaterThanOrEqual(TEXT_SIZE_PX['text-xl'])
    expect(baseFontSizePx(roundCounter)).toBeGreaterThan(TEXT_SIZE_PX['text-xs'])
  })

  it('announces the phase once, from the same markup the sighted user reads', () => {
    render(<BoxingTimer />)
    startWorkout()

    // A polite live region, so a phase change is announced — unlike the countdown, which stays
    // `aria-live="off"` because a per-second announcement is unusable.
    expect(banner()).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('timer')).toHaveAttribute('aria-live', 'off')
  })

  it('gives the countdown more room once a workout is on screen', () => {
    render(<BoxingTimer />)

    const idleSize = baseFontSizePx(screen.getByRole('timer'))

    startWorkout()

    expect(baseFontSizePx(screen.getByRole('timer'))).toBeGreaterThan(idleSize as number)
  })
})

/* -------------------------------------------------------------------------- */
/* Colour as the work/rest signal                                              */
/* -------------------------------------------------------------------------- */

describe('the work and rest phases are distinguished by a filled colour', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_700_000_000_000))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('paints the work phase with the paired --work tokens', () => {
    render(<BoxingTimer />)
    configure({ rounds: 2, roundSeconds: 2, prepSeconds: 0 })

    startWorkout()

    expect(banner().className).toContain('bg-work')
    expect(banner().className).toContain('text-work-foreground')
    expect(screen.getByText('Work')).toBeInTheDocument()
  })

  it('paints the rest phase with the paired --rest tokens, which are a different fill', () => {
    render(<BoxingTimer />)
    configure({ rounds: 2, roundSeconds: 2, prepSeconds: 0 })

    startWorkout()
    const workFill = banner().className

    advance(2_500) // round 1 (2 s) is over: this is the rest that follows it

    expect(screen.getByText('Recover')).toBeInTheDocument()
    expect(banner().className).toContain('bg-rest')
    expect(banner().className).toContain('text-rest-foreground')
    expect(banner().className).not.toBe(workFill)
    // Requirement 9.11: the distinction is not carried by a literal palette colour.
    expect(banner().className).not.toMatch(/emerald/)
  })
})

/* -------------------------------------------------------------------------- */
/* Progressive disclosure of controls                                          */
/* -------------------------------------------------------------------------- */

describe('the control set follows the phase', () => {
  it('renders no disabled control, and no Stop or Reset, while idle', () => {
    const { container } = render(<BoxingTimer />)

    expect(container.querySelectorAll('button[disabled]')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /^stop$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^reset$/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^start workout$/i })).toBeInTheDocument()
  })

  it('offers Pause and Stop — and no dead Start — while running', () => {
    render(<BoxingTimer />)

    startWorkout()

    expect(screen.getByRole('button', { name: /^pause$/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /^start workout$/i })).not.toBeInTheDocument()
  })

  it('offers Resume and Stop while paused', () => {
    render(<BoxingTimer />)

    startWorkout()
    fireEvent.click(screen.getByRole('button', { name: /^pause$/i }))

    expect(screen.getByRole('button', { name: /^resume$/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeEnabled()
  })

  it('withdraws the timer-settings sheet while running, because every field in it is disabled', () => {
    stubViewport({ mobile: true })
    render(<BoxingTimer />)

    // Requirement 10.9: the sheet is the phone's route to the configuration while idle.
    expect(screen.getByRole('button', { name: 'Timer settings' })).toBeInTheDocument()

    startWorkout()

    expect(screen.queryByRole('button', { name: 'Timer settings' })).not.toBeInTheDocument()
  })

  it('keeps the phone control row to one row of at most two controls', () => {
    stubViewport({ mobile: true })
    render(<BoxingTimer />)

    const controlRow = screen.getByRole('button', { name: /^start workout$/i }).parentElement
    expect(controlRow).not.toBeNull()
    expect(within(controlRow as HTMLElement).getAllByRole('button')).toHaveLength(1)

    startWorkout()

    expect(within(controlRow as HTMLElement).getAllByRole('button')).toHaveLength(2)
  })
})

/* -------------------------------------------------------------------------- */
/* The background-audio note (requirement 4.6)                                 */
/* -------------------------------------------------------------------------- */

describe('the background-audio limitation is disclosed rather than permanent', () => {
  const NOTE = /iOS suspends web audio while the browser is backgrounded/i

  it('is behind a labelled disclosure that is collapsed by default', () => {
    render(<BoxingTimer />)

    const disclosure = screen.getByRole('button', { name: /background audio/i })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it('reveals the note, in full, when the disclosure is opened', () => {
    render(<BoxingTimer />)

    fireEvent.click(screen.getByRole('button', { name: /background audio/i }))

    const note = screen.getByText(NOTE)
    // Requirement 4.6: still the whole statement — the limitation *and* that the countdown
    // itself stays accurate. Nothing was deleted to make room.
    expect(note.textContent).toMatch(/keeps running on wall-clock time and stays accurate/i)
    expect(screen.getByRole('button', { name: /background audio/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('stays reachable while a workout is running', () => {
    render(<BoxingTimer />)

    startWorkout()

    expect(screen.getByRole('button', { name: /background audio/i })).toBeInTheDocument()
  })
})

/* -------------------------------------------------------------------------- */
/* Redundant state                                                             */
/* -------------------------------------------------------------------------- */

describe('the panel states each fact once', () => {
  it('drops the READY badge and the READY WHEN YOU ARE caption', () => {
    render(<BoxingTimer />)

    expect(screen.queryByText(/ready when you are/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^ready$/i)).not.toBeInTheDocument()
    // What is left in their place is the configuration the Start button cannot tell you.
    expect(screen.getByText(/12 × 03:00/)).toBeInTheDocument()
  })

  it('renders the phase word exactly once while running', () => {
    render(<BoxingTimer />)
    // No lead-in, so the first round is live the moment Start is pressed.
    configure({ rounds: 2, roundSeconds: 30, prepSeconds: 0 })

    startWorkout()

    // The banner carries it; the caption under the countdown does not repeat it.
    expect(screen.getAllByText('Work')).toHaveLength(1)
  })
})
