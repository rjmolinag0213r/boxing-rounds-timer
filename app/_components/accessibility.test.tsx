/**
 * Accessibility and responsive rendering across the four views (task 12.4).
 *
 * Four contracts are pinned here:
 *
 * - **Touch targets** (requirement 10.3) — Start, Pause and Stop each declare a ≥ 44 × 44 CSS
 *   pixel minimum. jsdom performs no layout and Tailwind is not compiled in this environment, so
 *   the assertion reads the arbitrary-value utility itself (`min-h-[44px]`) and checks the number
 *   inside it. That number *is* the CSS Tailwind emits, which is what the requirement constrains.
 * - **Accessible names** (requirement 10.8) — every keyboard-reachable control in the timer,
 *   builder, history and sound-settings views resolves to a non-empty name, whether from an
 *   `aria-label`, an associated `<label>`, or its own text.
 * - **Focus indicators** (requirement 10.6) — every one of those controls declares a focus ring
 *   derived from `--ring`, never a bespoke colour and never `outline-none` on its own.
 * - **Reduced motion** (requirement 10.7) — the app's own animated elements opt out of their CSS
 *   transitions, and framer-motion's travel offsets collapse, when the user asks for less motion.
 *
 * **Validates: Requirements 10.3, 10.6, 10.7, 10.8**
 */

import { render, screen, waitFor, type RenderResult } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import BoxingTimer from '@/app/_components/boxing-timer'
import HistoryView from '@/app/_components/history-view'
import SoundSettings from '@/app/_components/sound-settings'
import WorkoutBuilder from '@/app/_components/workout-builder'
import { resetWorkoutLibraryForTests } from '@/lib/data/workoutLibrary'
import {
  MAX_REDUCED_MOTION_MS,
  motionDurationSeconds,
  motionOffset,
  usePrefersReducedMotion,
} from '@/lib/ui/motion'
import type { WorkoutSessionDTO } from '@/lib/types'

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** jsdom implements no `matchMedia`; this is the narrowest stub the hooks need. */
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

/** Every element a keyboard can land on. */
const FOCUSABLE_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'a[href]',
  '[role="button"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="radio"]',
  '[role="tab"]',
  '[tabindex]',
].join(', ')

/** The focusable controls of a rendered view, excluding anything hidden from assistive tech. */
function focusableControls(container: HTMLElement): HTMLElement[] {
  const found = new Set<HTMLElement>()
  for (const element of Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  )) {
    if (element.getAttribute('tabindex') === '-1') continue
    if (element.getAttribute('aria-hidden') === 'true') continue
    if (element.closest('[aria-hidden="true"]') !== null) continue
    if (element.closest('[hidden]') !== null) continue
    if (element instanceof HTMLInputElement && element.type === 'hidden') continue
    found.add(element)
  }
  return [...found]
}

/**
 * The accessible name, computed the way the platform does for the patterns this app uses:
 * `aria-label`, then `aria-labelledby`, then an associated or wrapping `<label>`, then the
 * element's own text, then `title`.
 */
function accessibleName(element: HTMLElement): string {
  const ariaLabel = element.getAttribute('aria-label')
  if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim()

  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim()
    if (text !== '') return text
  }

  if (element.id !== '') {
    const label = element.ownerDocument.querySelector(`label[for="${element.id}"]`)
    const text = label?.textContent?.trim() ?? ''
    if (text !== '') return text
  }

  const wrappingLabel = element.closest('label')?.textContent?.trim() ?? ''
  if (wrappingLabel !== '') return wrappingLabel

  const own = element.textContent?.trim() ?? ''
  if (own !== '') return own

  return element.getAttribute('title')?.trim() ?? ''
}

/** Describes an element well enough to identify it in a failure message. */
const describeElement = (element: HTMLElement): string =>
  `<${element.tagName.toLowerCase()}${
    element.getAttribute('role') !== null ? ` role="${element.getAttribute('role')}"` : ''
  } class="${(element.getAttribute('class') ?? '').slice(0, 60)}">`

/**
 * The focus ring `--ring` produces. Tailwind's `ring-ring` maps to `hsl(var(--ring))`, so its
 * presence — under `focus:` or `focus-visible:` — is what requirement 10.6 asks for.
 */
const RING_FROM_TOKEN = /focus(-visible)?:ring-ring/

/** The numeric value inside a `min-h-[NNpx]` / `min-w-[NNpx]` arbitrary-value utility. */
function minSizePx(element: HTMLElement, axis: 'h' | 'w'): number | null {
  const match = new RegExp(`min-${axis}-\\[(\\d+(?:\\.\\d+)?)px\\]`).exec(
    element.getAttribute('class') ?? ''
  )
  return match === null ? null : Number(match[1])
}

const MINIMUM_TOUCH_TARGET_PX = 44

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const SESSION: WorkoutSessionDTO = {
  id: 'session-1',
  workoutId: null,
  workoutName: 'Classic 12×3',
  type: 'BOXING',
  roundsPlanned: 12,
  roundsCompleted: 12,
  totalDurationMs: 3_723_000,
  completed: true,
  startedAt: new Date(2024, 5, 12, 9, 0, 0).getTime(),
  endedAt: new Date(2024, 5, 12, 10, 0, 0).getTime(),
}

/** Renders each view under test, with its async first paint already settled. */
const VIEWS: ReadonlyArray<{ name: string; mount: () => Promise<RenderResult> }> = [
  {
    name: 'timer',
    mount: async () => {
      const result = render(<BoxingTimer />)
      await waitFor(() => expect(screen.getByRole('timer')).toBeInTheDocument())
      return result
    },
  },
  {
    name: 'builder',
    mount: async () => {
      const result = render(<WorkoutBuilder />)
      await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument())
      return result
    },
  },
  {
    name: 'history',
    mount: async () => {
      const result = render(
        <HistoryView
          repository={{ listHistory: async () => [SESSION] }}
          now={() => SESSION.endedAt}
        />
      )
      await waitFor(() => expect(screen.getByText('Classic 12×3')).toBeInTheDocument())
      return result
    },
  },
  {
    name: 'sound settings',
    mount: async () => {
      const result = render(<SoundSettings />)
      await waitFor(() =>
        expect(screen.getByRole('switch', { name: 'Mute all sounds' })).toBeInTheDocument()
      )
      return result
    },
  },
]

/* -------------------------------------------------------------------------- */
/* Touch targets (requirement 10.3)                                            */
/* -------------------------------------------------------------------------- */

describe('timer controls meet the 44 px touch target', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetWorkoutLibraryForTests()
    stubViewport()
  })

  it.each([['start workout'], ['stop'], ['reset']])(
    'gives the %s control at least 44 × 44 CSS pixels',
    async (name) => {
      render(<BoxingTimer />)

      const control = screen.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })

      expect(minSizePx(control, 'h')).toBeGreaterThanOrEqual(MINIMUM_TOUCH_TARGET_PX)
      expect(minSizePx(control, 'w')).toBeGreaterThanOrEqual(MINIMUM_TOUCH_TARGET_PX)
    }
  )

  it('gives Pause at least 44 × 44 CSS pixels once the workout is running', async () => {
    render(<BoxingTimer />)

    screen.getByRole('button', { name: /start workout/i }).click()

    const pause = await screen.findByRole('button', { name: /^pause$/i })
    expect(minSizePx(pause, 'h')).toBeGreaterThanOrEqual(MINIMUM_TOUCH_TARGET_PX)
    expect(minSizePx(pause, 'w')).toBeGreaterThanOrEqual(MINIMUM_TOUCH_TARGET_PX)
  })
})

/* -------------------------------------------------------------------------- */
/* Responsive layout (requirements 10.4, 10.5, 10.9)                           */
/* -------------------------------------------------------------------------- */

describe('the timer layout is mobile-first', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetWorkoutLibraryForTests()
  })

  it('renders the primary action at full container width below 640 px', () => {
    stubViewport({ mobile: true })
    render(<BoxingTimer />)

    // Requirement 10.4: full width on a phone, intrinsic width from 640 px up.
    const start = screen.getByRole('button', { name: /start workout/i })
    expect(start.className).toContain('w-full')
    expect(start.className).toContain('sm:w-auto')
  })

  it('renders the countdown monospaced, tabular, and larger at 1024 px than below 640 px', () => {
    stubViewport()
    render(<BoxingTimer />)

    // Requirement 10.5.
    const countdown = screen.getByRole('timer')
    expect(countdown.className).toContain('font-mono')
    expect(countdown.className).toContain('tabular-nums')

    const sizeFor = (prefix: string): number => {
      const match = new RegExp(`${prefix}text-(\\d)xl`).exec(countdown.getAttribute('class') ?? '')
      expect(match, `no ${prefix || 'base'} font size declared`).not.toBeNull()
      return Number(match![1])
    }

    expect(sizeFor('lg:')).toBeGreaterThan(sizeFor('(?<![a-z:])'))
  })

  it('moves the timer settings into a bottom sheet below 640 px', () => {
    stubViewport({ mobile: true })
    render(<BoxingTimer />)

    // Requirement 10.9: a drawer trigger replaces the side panel.
    expect(screen.getByRole('button', { name: 'Timer settings' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('keeps the timer settings in the side panel at 640 px and up', () => {
    stubViewport({ mobile: false })
    render(<BoxingTimer />)

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Timer settings' })).not.toBeInTheDocument()
  })
})

/* -------------------------------------------------------------------------- */
/* Accessible names and focus indicators (requirements 10.6, 10.8)             */
/* -------------------------------------------------------------------------- */

describe.each(VIEWS)('the $name view', ({ mount }) => {
  beforeEach(() => {
    window.localStorage.clear()
    resetWorkoutLibraryForTests()
    stubViewport()
  })

  it('gives every interactive control an accessible name', async () => {
    const { container } = await mount()

    const controls = focusableControls(container)
    expect(controls.length).toBeGreaterThan(0)

    const unnamed = controls.filter((control) => accessibleName(control) === '')
    expect(unnamed.map(describeElement)).toEqual([])
  })

  it('gives every keyboard-focusable element a --ring-derived focus indicator', async () => {
    const { container } = await mount()

    const withoutRing = focusableControls(container).filter(
      (control) => !RING_FROM_TOKEN.test(control.getAttribute('class') ?? '')
    )
    expect(withoutRing.map(describeElement)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* Reduced motion (requirement 10.7)                                           */
/* -------------------------------------------------------------------------- */

describe('reduced motion', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetWorkoutLibraryForTests()
  })

  /** Reports what the animated components read, as an attribute a test can assert on. */
  function Probe(): JSX.Element {
    const reduced = usePrefersReducedMotion()
    return <span data-testid="probe" data-reduced={String(reduced)} />
  }

  it.each([[true], [false]])(
    'reports prefers-reduced-motion: reduce as %s to every animated component',
    (reducedMotion) => {
      stubViewport({ reducedMotion })
      render(<Probe />)

      expect(screen.getByTestId('probe')).toHaveAttribute('data-reduced', String(reducedMotion))
    }
  )

  it('caps the duration every animated component asks for at 10 ms', () => {
    // The durations `components/ui/animate.tsx` and the timer view request, in seconds.
    for (const seconds of [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.9]) {
      expect(motionDurationSeconds(seconds, true) * 1000).toBeLessThanOrEqual(
        MAX_REDUCED_MOTION_MS
      )
      expect(motionDurationSeconds(seconds, false)).toBe(seconds)
    }
  })

  it('collapses framer-motion travel offsets under reduced motion', () => {
    // Requirement 10.7's "omit the animated transition" half: the element fades in place
    // instead of sliding into position.
    expect(motionOffset(16, true)).toBe(0)
    expect(motionOffset(16, false)).toBe(16)
  })

  it('opts the timer’s own CSS transitions out under reduced motion', () => {
    stubViewport({ reducedMotion: true })
    const { container } = render(<BoxingTimer />)

    // Requirement 10.7: every element this view gives a timed CSS transition also declares the
    // `motion-reduce` escape, on top of the global 10 ms cap in `app/globals.css`.
    const timed = Array.from(container.querySelectorAll<HTMLElement>('[class*="duration-"]'))
      .filter((element) => /(^|\s)transition-/.test(element.getAttribute('class') ?? ''))
      .filter((element) => /duration-\d/.test(element.getAttribute('class') ?? ''))

    expect(timed.length).toBeGreaterThan(0)
    const withoutEscape = timed.filter(
      (element) => !(element.getAttribute('class') ?? '').includes('motion-reduce:transition-none')
    )
    expect(withoutEscape.map(describeElement)).toEqual([])
  })
})
