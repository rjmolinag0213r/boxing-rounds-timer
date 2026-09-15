'use client'

/**
 * The reduced-motion contract (requirement 10.7).
 *
 * Two kinds of animation exist in this app and each needs its own answer:
 *
 * - **CSS transitions and keyframes** are handled declaratively — the
 *   `@media (prefers-reduced-motion: reduce)` block in `app/globals.css` caps every
 *   `transition-duration` and `animation-duration` at {@link MAX_REDUCED_MOTION_MS}, so no
 *   component has to remember to opt in.
 * - **framer-motion transitions** are JavaScript values, invisible to that media query. They
 *   read {@link usePrefersReducedMotion} and pass their duration through
 *   {@link motionDurationSeconds}, which caps it at the same 10 ms ceiling.
 *
 * The cap is 10 ms rather than 0 so a transition still *ends* — a zero-duration framer-motion
 * transition is a different code path (it snaps without firing completion callbacks), and
 * requirement 10.7 explicitly permits "at most 10 milliseconds".
 *
 * Requirements: 10.7
 */

import { useMediaQuery } from './useMediaQuery'

/** The media query the accessibility preference is reported through. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** The ceiling requirement 10.7 allows for any single transition, in milliseconds. */
export const MAX_REDUCED_MOTION_MS = 10

/** `true` while the user agent reports `prefers-reduced-motion: reduce`. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY)
}

/**
 * Caps a duration expressed in milliseconds.
 *
 * Returns `preferredMs` untouched when motion is welcome, and never more than
 * {@link MAX_REDUCED_MOTION_MS} when it is not.
 */
export function motionDurationMs(preferredMs: number, reduced: boolean): number {
  const preferred = Number.isFinite(preferredMs) ? Math.max(0, preferredMs) : 0
  return reduced ? Math.min(preferred, MAX_REDUCED_MOTION_MS) : preferred
}

/** {@link motionDurationMs} in the seconds framer-motion's `transition.duration` expects. */
export function motionDurationSeconds(preferredSeconds: number, reduced: boolean): number {
  return motionDurationMs(preferredSeconds * 1000, reduced) / 1000
}

/**
 * The offset an enter/exit animation travels.
 *
 * Under reduced motion the element fades in place instead of sliding, which is the "omit the
 * animated transition" half of requirement 10.7.
 */
export function motionOffset(preferredPx: number, reduced: boolean): number {
  return reduced ? 0 : preferredPx
}
