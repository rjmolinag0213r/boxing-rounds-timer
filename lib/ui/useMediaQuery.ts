'use client'

/**
 * A single, SSR-safe `matchMedia` subscription.
 *
 * Three of the layout rules in requirement 10 are conditional on the *viewport*, not on a
 * breakpoint utility: below 640 CSS pixels the timer settings move into a bottom sheet
 * (requirement 10.9) and sound settings open as a drawer rather than a dialog
 * (requirement 10.2), and under `prefers-reduced-motion: reduce` animation durations are
 * capped (requirement 10.7). Those need the *component tree* to change, not just a class, so
 * a Tailwind `sm:` variant cannot express them — only one of the two variants may be mounted,
 * or the accessibility tree would carry duplicate controls with identical names.
 *
 * The hook starts at `false` on purpose: the server has no viewport, so the desktop tree is
 * the one that renders during hydration and the mobile tree swaps in on mount. `matchMedia`
 * is absent in jsdom, so every access is guarded and simply reports `false` there unless a
 * test provides its own stub.
 *
 * Requirements: 10.2, 10.7, 10.9
 */

import { useEffect, useState } from 'react'

/** The `sm` breakpoint's complement: Tailwind's `sm` starts at 640 px. */
export const MOBILE_MEDIA_QUERY = '(max-width: 639px)'

/** Resolves a media query once, defensively. Returns `false` where `matchMedia` is absent. */
export function matchesMediaQuery(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(query).matches === true
  } catch {
    return false
  }
}

/** `true` while `query` matches. Re-renders on every change. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return

    let list: MediaQueryList
    try {
      list = window.matchMedia(query)
    } catch {
      return
    }

    setMatches(list.matches === true)

    const onChange = (event: MediaQueryListEvent | MediaQueryList): void => {
      setMatches(event.matches === true)
    }

    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', onChange as (event: MediaQueryListEvent) => void)
      return () => {
        list.removeEventListener('change', onChange as (event: MediaQueryListEvent) => void)
      }
    }
    // Safari < 14 and some stubs only implement the deprecated listener API.
    if (typeof list.addListener === 'function') {
      list.addListener(onChange)
      return () => {
        list.removeListener(onChange)
      }
    }
    return
  }, [query])

  return matches
}

/** `true` below the 640 CSS pixel breakpoint (requirements 10.4, 10.9). */
export function useIsMobileViewport(): boolean {
  return useMediaQuery(MOBILE_MEDIA_QUERY)
}
