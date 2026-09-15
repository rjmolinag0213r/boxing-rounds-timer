import { fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import BoxingTimer from '@/app/_components/boxing-timer'

/**
 * Integration test for the background/foreground flow (task 4.3).
 *
 * This exercises the whole view — configuration, engine binding, rendering — with a
 * mocked system clock. The tab is suspended by advancing `Date.now` *without* letting any
 * interval fire, which is exactly what iOS Safari does to a backgrounded page: the display
 * driver stops, wall-clock time does not. The assertions then check that a single
 * `visibilitychange` reconciliation lands on the phase and remaining time that wall-clock
 * arithmetic predicts, rather than on whatever a tick counter would have reached.
 *
 * Requirements: 1.5, 1.6, 1.11
 */

const T0 = 1_700_000_000_000

/** The default configuration rendered by the view. */
const PREP_S = 5
const ROUNDS = 12
const ROUND_S = 180
const REST_S = 60
const TOTAL_S = PREP_S + ROUNDS * ROUND_S + (ROUNDS - 1) * REST_S // 2825

describe('BoxingTimer background/foreground flow', () => {
  let visibility: DocumentVisibilityState = 'visible'

  /** Reads the countdown digits rendered inside the ring. */
  const countdown = (): string => screen.getByRole('timer').textContent ?? ''

  /** Suspends the tab: wall-clock time keeps running, the display driver does not. */
  const hide = (): void => {
    visibility = 'hidden'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }

  /** Foregrounds the tab, firing `visibilitychange` without advancing any timer. */
  const show = (): void => {
    visibility = 'visible'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }

  /** Moves wall-clock time forward while the tab is suspended (no timers fire). */
  const suspendFor = (ms: number): void => {
    act(() => {
      vi.setSystemTime(new Date(Date.now() + ms))
    })
  }

  /** Moves wall-clock time forward *and* lets the 250 ms display driver run. */
  const advance = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  const startWorkout = (): void => {
    fireEvent.click(screen.getByRole('button', { name: /start workout/i }))
  }

  beforeEach(() => {
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })
    window.localStorage.clear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lands on the wall-clock phase and remaining time after a hidden interval that crossed two boundaries', () => {
    render(<BoxingTimer />)

    startWorkout()

    // The lead-in is showing, and the display refreshes as the driver ticks (req 1.11).
    expect(countdown()).toBe('00:05')
    advance(1_000)
    expect(countdown()).toBe('00:04')

    hide()

    // 200 s of wall-clock time passes with the page suspended. That crosses the end of
    // prep (5 s) and the end of round 1 (185 s), landing 15 s into the first rest.
    suspendFor(200_000 - 1_000)
    expect(countdown()).toBe('00:04') // nothing recomputed while hidden

    show()

    // Wall-clock expectation: rest 1 runs 185 s -> 245 s, so 45 s remain (req 1.5, 1.6).
    const expectedRemaining = PREP_S + ROUND_S + REST_S - 200
    expect(expectedRemaining).toBe(45)
    expect(countdown()).toBe('00:45')
    expect(screen.getByText('Recover')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument() // Round 1 / 12

    // And it keeps counting from there once foregrounded.
    advance(5_000)
    expect(countdown()).toBe('00:40')
  })

  it('reports a finished workout when the hidden interval outlasts the whole timeline', () => {
    render(<BoxingTimer />)

    startWorkout()
    hide()

    suspendFor((TOTAL_S + 120) * 1_000)
    show()

    expect(countdown()).toBe('00:00')
    expect(screen.getByText('All rounds done')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start workout/i })).toBeInTheDocument()
  })

  it('excludes paused wall-clock time from the countdown', () => {
    render(<BoxingTimer />)

    startWorkout()
    advance(5_000) // prep elapsed; round 1 is running
    expect(countdown()).toBe('03:00')

    fireEvent.click(screen.getByRole('button', { name: /pause/i }))
    expect(screen.getByText('Paused')).toBeInTheDocument()

    // A minute of wall-clock time passes, including a background interval, while paused.
    advance(30_000)
    hide()
    suspendFor(30_000)
    show()
    expect(countdown()).toBe('03:00')

    fireEvent.click(screen.getByRole('button', { name: /resume/i }))
    advance(10_000)
    expect(countdown()).toBe('02:50')
  })
})
