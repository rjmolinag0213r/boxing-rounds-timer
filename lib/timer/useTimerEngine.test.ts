import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TimerSoundEvent } from '@/lib/timer/useTimerEngine'
import { useTimerEngine } from '@/lib/timer/useTimerEngine'
import type { WorkoutSpec } from '@/lib/timer/types'

/**
 * Unit tests for the visibility reconciler (task 2.14).
 *
 * The clock is injected (`now`), so nothing here depends on real time: `clockMs` is
 * advanced by hand to simulate an iOS Safari tab that was suspended for an arbitrary
 * interval, and `vi.advanceTimersByTime` is used only to drive the 250 ms display
 * interval.
 *
 * Requirements: 1.5, 2.12
 */

/** 3 x 60 s rounds with 30 s rests and no prep => 60+30+60+30+60 = 240 s total. */
const SPEC: WorkoutSpec = { prepSeconds: 0, rounds: 3, roundSeconds: 60, restSeconds: 30 }

const T0 = 1_700_000_000_000

describe('useTimerEngine reconciler', () => {
  let clockMs = T0
  let nowCalls = 0
  let visibility: DocumentVisibilityState = 'visible'
  let soundEvents: TimerSoundEvent[] = []

  /** Injected wall clock; every reconciliation reads it exactly once. */
  const now = (): number => {
    nowCalls += 1
    return clockMs
  }

  const setup = (spec: WorkoutSpec = SPEC) =>
    renderHook(() =>
      useTimerEngine({
        spec,
        now,
        onSoundEvent: (event) => {
          soundEvents.push(event)
        },
      })
    )

  /** Advances the wall clock *and* lets the display interval fire. */
  const advance = (ms: number): void => {
    act(() => {
      clockMs += ms
      vi.advanceTimersByTime(ms)
    })
  }

  /** Suspends the tab: the clock keeps running, the interval does not. */
  const hide = (): void => {
    act(() => {
      visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }

  /** Foregrounds the tab, firing `visibilitychange` with no timer advancement at all. */
  const show = (): void => {
    act(() => {
      visibility = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }

  beforeEach(() => {
    clockMs = T0
    nowCalls = 0
    visibility = 'visible'
    soundEvents = []
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts idle with the first segment at full duration and elapsed 0', () => {
    const { result } = setup()

    expect(result.current.status).toBe('idle')
    expect(result.current.snapshot.phase).toBe('idle')
    expect(result.current.snapshot.remainingMs).toBe(60_000)
    expect(result.current.snapshot.elapsedWorkoutMs).toBe(0)
    expect(soundEvents).toHaveLength(0)
  })

  it('refreshes the display at least once every 250 ms while visible and running', () => {
    const { result } = setup()

    act(() => result.current.start())
    expect(result.current.snapshot.phase).toBe('round')
    expect(result.current.snapshot.remainingMs).toBe(60_000)

    advance(250)
    expect(result.current.snapshot.remainingMs).toBe(59_750)

    advance(250)
    expect(result.current.snapshot.remainingMs).toBe(59_500)
  })

  it('runs no reconciliation while the document is hidden', () => {
    const { result } = setup()

    act(() => result.current.start())
    hide()

    const callsWhenHidden = nowCalls
    advance(5_000)

    // The interval is torn down while hidden, so nothing recomputed.
    expect(nowCalls).toBe(callsWhenHidden)
  })

  it('reconciles exactly once, synchronously, on a hidden -> visible clock jump', () => {
    const { result } = setup()

    act(() => result.current.start())
    advance(1_000)
    expect(result.current.snapshot.phase).toBe('round')

    hide()

    // The tab was suspended for 75 s of wall-clock time, crossing the round 1 -> rest
    // boundary at 60 s. No interval fired during that window.
    act(() => {
      clockMs += 75_000
    })

    const callsBefore = nowCalls
    const eventsBefore = soundEvents.length
    const dispatchedAtMs = clockMs

    show()

    // Requirement 1.5: a single Reconciliation, performed inside the `visibilitychange`
    // handler itself — no timer advancement was needed to trigger it.
    expect(nowCalls - callsBefore).toBe(1)

    // Correct phase after the jump: 76 s in is 16 s into the 30 s rest following round 1.
    expect(result.current.snapshot.phase).toBe('rest')
    expect(result.current.snapshot.currentRound).toBe(1)
    expect(result.current.snapshot.remainingMs).toBe(14_000)
    expect(result.current.snapshot.elapsedWorkoutMs).toBe(76_000)

    // Exactly one transition sound for the whole catch-up, naming the landed segment.
    const emitted = soundEvents.slice(eventsBefore)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].role).toBe('restStart')
    expect(emitted[0].segment).toMatchObject({ kind: 'rest', index: 1 })

    // Reconciliation latency: the event was handled at the timestamp of the
    // `visibilitychange` dispatch, i.e. 0 ms later — well inside the 250 ms budget.
    expect(emitted[0].atMs - dispatchedAtMs).toBeLessThan(250)
    expect(emitted[0].atMs - dispatchedAtMs).toBe(0)
  })

  it('lands on finished with a single event when the jump passes the end of the workout', () => {
    const { result } = setup()

    act(() => result.current.start())
    hide()

    act(() => {
      clockMs += 10 * 60_000 // ten minutes: far past the 240 s total
    })

    const eventsBefore = soundEvents.length
    show()

    expect(result.current.status).toBe('finished')
    expect(result.current.snapshot.phase).toBe('finished')
    expect(result.current.snapshot.finished).toBe(true)
    expect(result.current.snapshot.remainingMs).toBe(0)
    expect(result.current.snapshot.elapsedWorkoutMs).toBe(240_000)

    const emitted = soundEvents.slice(eventsBefore)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].role).toBe('finished')
  })

  it('excludes paused wall-clock time from elapsed time', () => {
    const { result } = setup()

    act(() => result.current.start())
    advance(10_000)
    expect(result.current.snapshot.remainingMs).toBe(50_000)

    act(() => result.current.pause())
    expect(result.current.status).toBe('paused')
    expect(result.current.snapshot.phase).toBe('paused')

    // 30 s of wall-clock time passes while paused; the workout clock must not move.
    advance(30_000)
    expect(result.current.snapshot.elapsedWorkoutMs).toBe(10_000)
    expect(result.current.snapshot.remainingMs).toBe(50_000)

    act(() => result.current.resume())
    expect(result.current.status).toBe('running')
    expect(result.current.snapshot.remainingMs).toBe(50_000)

    advance(5_000)
    expect(result.current.snapshot.elapsedWorkoutMs).toBe(15_000)
    expect(result.current.snapshot.remainingMs).toBe(45_000)
  })

  it('returns to idle with elapsed 0 when stopped', () => {
    const { result } = setup()

    act(() => result.current.start())
    advance(65_000)
    expect(result.current.snapshot.phase).toBe('rest')

    act(() => result.current.stop())

    expect(result.current.status).toBe('idle')
    expect(result.current.snapshot.phase).toBe('idle')
    expect(result.current.snapshot.elapsedWorkoutMs).toBe(0)
    expect(result.current.snapshot.remainingMs).toBe(60_000)
    expect(result.current.lastSoundEvent).toBeNull()
  })

  it('announces the first segment on start and does not re-announce it on resume', () => {
    const { result } = setup({ prepSeconds: 5, rounds: 2, roundSeconds: 60, restSeconds: 30 })

    act(() => result.current.start())
    expect(soundEvents.map((event) => event.role)).toEqual(['prepStart'])

    // Backgrounding and foregrounding inside the same segment announces nothing new.
    hide()
    act(() => {
      clockMs += 2_000
    })
    show()

    expect(soundEvents.map((event) => event.role)).toEqual(['prepStart'])
    expect(result.current.snapshot.phase).toBe('prep')
    expect(result.current.snapshot.remainingMs).toBe(3_000)
  })
})
