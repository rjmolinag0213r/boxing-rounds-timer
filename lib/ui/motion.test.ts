/**
 * The reduced-motion contract (task 12.3, requirement 10.7).
 *
 * Two mechanisms have to agree: the CSS media query in `app/globals.css` caps declarative
 * transitions, and `lib/ui/motion.ts` caps the framer-motion durations that query cannot reach.
 * These tests pin both — the helper's arithmetic, and the fact that the animated components
 * actually route their durations through it rather than hardcoding a number.
 *
 * **Validates: Requirement 10.7**
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  MAX_REDUCED_MOTION_MS,
  REDUCED_MOTION_QUERY,
  motionDurationMs,
  motionDurationSeconds,
  motionOffset,
} from './motion'
import { MOBILE_MEDIA_QUERY, matchesMediaQuery } from './useMediaQuery'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (...segments: string[]): string =>
  readFileSync(path.join(ROOT, ...segments), 'utf8')

/** Every framer-motion duration used anywhere in the app, in seconds. */
const DURATIONS_IN_USE = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.9, 1.5]

describe('motionDurationMs', () => {
  it('leaves the preferred duration untouched when motion is welcome', () => {
    expect(motionDurationMs(900, false)).toBe(900)
    expect(motionDurationMs(0, false)).toBe(0)
  })

  it('caps every duration in use at 10 ms under reduced motion', () => {
    for (const seconds of DURATIONS_IN_USE) {
      const capped = motionDurationSeconds(seconds, true)
      expect(capped * 1000).toBeLessThanOrEqual(MAX_REDUCED_MOTION_MS)
    }
  })

  it('never lengthens a duration that is already shorter than the cap', () => {
    expect(motionDurationMs(4, true)).toBe(4)
    expect(motionDurationMs(0, true)).toBe(0)
  })

  it('treats a negative or non-finite duration as zero', () => {
    expect(motionDurationMs(-100, false)).toBe(0)
    expect(motionDurationMs(Number.NaN, true)).toBe(0)
    expect(motionDurationMs(Number.POSITIVE_INFINITY, true)).toBe(0)
  })

  it('drops the travel offset under reduced motion so the element fades in place', () => {
    expect(motionOffset(16, false)).toBe(16)
    expect(motionOffset(-4, true)).toBe(0)
  })
})

describe('matchesMediaQuery', () => {
  const original = window.matchMedia

  afterEach(() => {
    if (original) window.matchMedia = original
    else delete (window as { matchMedia?: unknown }).matchMedia
  })

  it('reports false where matchMedia is unimplemented, rather than throwing', () => {
    delete (window as { matchMedia?: unknown }).matchMedia
    expect(matchesMediaQuery(REDUCED_MOTION_QUERY)).toBe(false)
    expect(matchesMediaQuery(MOBILE_MEDIA_QUERY)).toBe(false)
  })

  it('reports what the user agent says', () => {
    window.matchMedia = ((query: string) => ({
      matches: query === REDUCED_MOTION_QUERY,
      media: query,
    })) as unknown as typeof window.matchMedia

    expect(matchesMediaQuery(REDUCED_MOTION_QUERY)).toBe(true)
    expect(matchesMediaQuery(MOBILE_MEDIA_QUERY)).toBe(false)
  })
})

describe('app/globals.css reduced-motion block', () => {
  const css = read('app', 'globals.css')

  it('declares a prefers-reduced-motion media query', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('caps every transition and animation at the 10 ms ceiling', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)')
    const query = css.slice(start, start + 700)

    for (const property of ['transition-duration', 'animation-duration']) {
      const match = new RegExp(`${property}:\\s*(\\d+)ms\\s*!important`).exec(query)
      expect(match, `${property} is not capped inside the media query`).not.toBeNull()
      expect(Number(match![1])).toBeLessThanOrEqual(MAX_REDUCED_MOTION_MS)
    }
  })
})

describe('animated components route their durations through the cap', () => {
  it.each([
    ['components/ui/animate.tsx'],
    ['app/_components/boxing-timer.tsx'],
  ])('%s hardcodes no framer-motion transition duration', (file) => {
    const source = read(...file.split('/'))

    // A literal `transition={{ duration: 0.4 }}` would be invisible to the CSS media query
    // and would therefore keep animating under `prefers-reduced-motion: reduce`.
    const hardcoded = source.match(/transition=\{\{[^}]*duration:\s*[\d.]+/g)
    expect(hardcoded, `hardcoded durations: ${hardcoded?.join(', ')}`).toBeNull()
    expect(source).toContain('motionDurationSeconds')
  })
})
