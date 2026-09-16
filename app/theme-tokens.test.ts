/**
 * Deterministic theme-token assertions for the red-and-white refresh.
 *
 * These are fixed file contents with no universally quantified input space, so they are
 * checked with plain assertions rather than property tests: the theme is a set of literal
 * token values in `app/globals.css`, a token-only usage rule in the timer view, and a
 * Tailwind mapping that must stay untouched.
 *
 * **Validates: Requirements 9.7, 9.13** (and, incidentally, 9.1–9.6)
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')

const GLOBALS_CSS = readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8')
const TIMER_VIEW = readFileSync(path.join(ROOT, 'app', '_components', 'boxing-timer.tsx'), 'utf8')
const SYNC_VIEW = readFileSync(path.join(ROOT, 'app', '_components', 'sync-settings.tsx'), 'utf8')
const TAILWIND_CONFIG = readFileSync(path.join(ROOT, 'tailwind.config.ts'), 'utf8')

/** Slices out a declaration block by its selector, up to the block's closing brace. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `selector \`${selector}\` not found in globals.css`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('\n  }', start)
  expect(end, `selector \`${selector}\` is not closed`).toBeGreaterThan(start)
  return css.slice(start, end)
}

/** The raw right-hand side of a custom property, e.g. `0 84% 55%`. */
function raw(scope: string, name: string): string {
  const match = scope.match(new RegExp(`--${name}:\\s*([^;]+);`))
  expect(match, `--${name} is not declared in the block`).not.toBeNull()
  return match![1].trim()
}

/** Parses an `H S% L%` triplet into numbers. */
function hsl(scope: string, name: string): { h: number; s: number; l: number } {
  const value = raw(scope, name)
  const match = value.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/)
  expect(match, `--${name} is not an "H S% L%" triplet (got "${value}")`).not.toBeNull()
  return { h: Number(match![1]), s: Number(match![2]), l: Number(match![3]) }
}

const LIGHT = block(GLOBALS_CSS, ':root')
const DARK = block(GLOBALS_CSS, '.dark')
const BLOCKS: ReadonlyArray<[string, string]> = [
  ['light (:root)', LIGHT],
  ['dark (.dark)', DARK],
]

/** Red hues live at 0–20; red-pink wraps around to 330–360. Purple/violet/indigo do not. */
const isRedFamilyHue = (h: number): boolean => h <= 20 || h >= 330

describe('app/globals.css design tokens', () => {
  it.each(BLOCKS)('declares --primary as a red hue in the %s block', (_label, scope) => {
    // Requirement 9.1: hue within 0–14 degrees.
    const primary = hsl(scope, 'primary')
    expect(primary.h).toBeGreaterThanOrEqual(0)
    expect(primary.h).toBeLessThanOrEqual(14)
    expect(primary.s).toBeGreaterThan(50)
  })

  it.each(BLOCKS)('declares --ring identical to --primary in the %s block', (_label, scope) => {
    // Requirement 9.2.
    expect(raw(scope, 'ring')).toBe(raw(scope, 'primary'))

    const ring = hsl(scope, 'ring')
    expect(ring.h).toBeGreaterThanOrEqual(0)
    expect(ring.h).toBeLessThanOrEqual(14)
  })

  it.each(BLOCKS)('declares --chart-1..5 in the red families in the %s block', (_label, scope) => {
    // Requirement 9.3: red / red-orange / red-pink only.
    for (const n of [1, 2, 3, 4, 5]) {
      const chart = hsl(scope, `chart-${n}`)
      expect(isRedFamilyHue(chart.h), `--chart-${n} hue ${chart.h} is not red-family`).toBe(true)
    }
  })

  it.each(BLOCKS)('declares white --primary-foreground in the %s block', (_label, scope) => {
    // Requirement 9.9: white on the chosen reds clears 4.5:1.
    const fg = hsl(scope, 'primary-foreground')
    expect(fg.l).toBeGreaterThanOrEqual(98)
  })

  it('keeps light --background and --card white', () => {
    // Requirement 9.5.
    expect(raw(LIGHT, 'background')).toBe('0 0% 100%')
    expect(raw(LIGHT, 'card')).toBe('0 0% 100%')
  })

  it('keeps dark --foreground near-white', () => {
    // Requirement 9.6.
    expect(hsl(DARK, 'foreground').l).toBeGreaterThanOrEqual(95)
    expect(hsl(DARK, 'background').l).toBeLessThanOrEqual(10)
  })

  it('provides a darker red --accent-foreground for small red text in light mode', () => {
    // Requirement 9.10: the token the timer view uses for red type below 18 px.
    const accentForeground = hsl(LIGHT, 'accent-foreground')
    expect(isRedFamilyHue(accentForeground.h)).toBe(true)
    expect(accentForeground.l).toBeLessThanOrEqual(45)
  })

  it.each([
    ['.hero-gradient', '.hero-gradient'],
    ['.dark .hero-gradient', '.dark .hero-gradient'],
  ])('paints %s with red-family hues only', (_label, selector) => {
    // Requirement 9.4: no purple, violet or indigo hues survive.
    const gradient = block(GLOBALS_CSS, selector)
    const hues = [...gradient.matchAll(/hsl\(\s*([\d.]+)\s/g)].map((m) => Number(m[1]))

    expect(hues.length).toBeGreaterThan(0)
    for (const hue of hues) {
      expect(isRedFamilyHue(hue), `hero gradient hue ${hue} is not red-family`).toBe(true)
    }
  })

  it('leaves the non-color tokens untouched', () => {
    expect(raw(LIGHT, 'radius')).toBe('0.625rem')
    expect(raw(LIGHT, 'spacing-md')).toBe('16px')
    expect(raw(LIGHT, 'duration-normal')).toBe('250ms')
  })
})

describe('app/_components/boxing-timer.tsx accent usage', () => {
  it('contains zero hardcoded red-500 / red-600 utilities', () => {
    // Requirement 9.7.
    expect(TIMER_VIEW.match(/red-500/g)).toBeNull()
    expect(TIMER_VIEW.match(/red-600/g)).toBeNull()
  })

  it('expresses the brand accent through --primary-derived utilities', () => {
    // Requirements 9.7, 9.12.
    for (const utility of ['text-primary', 'stroke-primary', 'bg-primary/10', 'ring-primary/30']) {
      expect(TIMER_VIEW).toContain(utility)
    }
  })
})

describe('app/_components/sync-settings.tsx accent usage', () => {
  /**
   * Every Tailwind palette family, so a literal colour cannot slip in under a name the
   * `red-500`/`red-600` check would miss. The Sync surface introduces destructive and
   * emphasis states, which are exactly the two places a literal red is most tempting.
   *
   * Requirement 12.15.
   */
  const PALETTE_FAMILIES = [
    'slate',
    'gray',
    'zinc',
    'neutral',
    'stone',
    'red',
    'orange',
    'amber',
    'yellow',
    'lime',
    'green',
    'emerald',
    'teal',
    'cyan',
    'sky',
    'blue',
    'indigo',
    'violet',
    'purple',
    'fuchsia',
    'pink',
    'rose',
  ] as const

  it('contains zero hardcoded red-500 / red-600 utilities', () => {
    // The same assertion the timer view carries, extended to the Sync surface.
    expect(SYNC_VIEW.match(/red-500/g)).toBeNull()
    expect(SYNC_VIEW.match(/red-600/g)).toBeNull()
  })

  it('contains zero literal Tailwind palette classes of any family', () => {
    for (const family of PALETTE_FAMILIES) {
      const literal = new RegExp(`(?:bg|text|border|ring|stroke|fill|divide)-${family}-\\d{2,3}`, 'g')
      expect(SYNC_VIEW.match(literal), `sync-settings.tsx uses a literal ${family} class`).toBeNull()
    }
  })

  it('expresses its states through semantic tokens', () => {
    // Emphasis, secondary text, surfaces and the destructive action all resolve through tokens.
    for (const utility of [
      'text-primary',
      'bg-primary/10',
      'text-muted-foreground',
      'bg-muted/40',
      'border-border',
      'text-destructive',
    ]) {
      expect(SYNC_VIEW).toContain(utility)
    }
    // The destructive control goes through the button variant, i.e. through `--destructive`.
    expect(SYNC_VIEW).toContain('variant="destructive"')
  })

  it('keeps the 44 pixel, --ring focus and reduced-motion conventions', () => {
    // Requirements 12.14, 12.16, 12.17.
    expect(SYNC_VIEW).toContain('min-h-[44px]')
    expect(SYNC_VIEW).toContain('focus-visible:ring-ring')
    expect(SYNC_VIEW).toContain('motion-reduce:transition-none')
  })
})

describe('tailwind.config.ts token mapping', () => {
  it('still maps primary, ring and chart-1..5 to their CSS variables', () => {
    // Requirement 9.13.
    for (const token of ['primary', 'ring', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']) {
      expect(TAILWIND_CONFIG).toContain(`hsl(var(--${token}))`)
    }
  })
})
