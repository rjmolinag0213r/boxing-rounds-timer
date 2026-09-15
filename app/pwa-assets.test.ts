/**
 * Deterministic PWA asset assertions.
 *
 * The manifest, the icon set and the service worker are fixed file contents with no
 * quantified input space, so they are checked with plain assertions rather than property
 * tests — a property here could only restate the literal expected value. What these do buy is
 * a guard against the three ways this bundle silently rots: a manifest field disappearing, an
 * icon entry pointing at a file nobody committed, and the brand red drifting out of step
 * between `app/globals.css`, the manifest and the document metadata.
 *
 * **Validates: Requirements 11.1, 11.2, 11.6, 11.10**
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public')

const MANIFEST_PATH = path.join(PUBLIC, 'manifest.webmanifest')
const SW_PATH = path.join(PUBLIC, 'sw.js')

const MANIFEST_TEXT = readFileSync(MANIFEST_PATH, 'utf8')
const SW_SOURCE = readFileSync(SW_PATH, 'utf8')
const GLOBALS_CSS = readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8')
const LAYOUT = readFileSync(path.join(ROOT, 'app', 'layout.tsx'), 'utf8')

interface ManifestIcon {
  src: string
  sizes: string
  type?: string
  purpose?: string
}

interface Manifest {
  name?: string
  short_name?: string
  start_url?: string
  display?: string
  orientation?: string
  theme_color?: string
  background_color?: string
  icons?: ManifestIcon[]
}

const manifest = JSON.parse(MANIFEST_TEXT) as Manifest

/** Converts an `H S% L%` triplet — the form every token in `globals.css` uses — to `#rrggbb`. */
function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100
  const lig = l / 100
  const c = (1 - Math.abs(2 * lig - 1)) * sat
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))

  let [r, g, b] = [0, 0, 0]
  if (hp < 1) [r, g] = [c, x]
  else if (hp < 2) [r, g] = [x, c]
  else if (hp < 3) [g, b] = [c, x]
  else if (hp < 4) [g, b] = [x, c]
  else if (hp < 5) [r, b] = [x, c]
  else [r, b] = [c, x]

  const m = lig - c / 2
  const byte = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}

/** Reads a custom property out of the `:root` block of `app/globals.css`. */
function rootToken(name: string): string {
  const rootStart = GLOBALS_CSS.indexOf(':root {')
  expect(rootStart, ':root block not found in globals.css').toBeGreaterThanOrEqual(0)
  const rootEnd = GLOBALS_CSS.indexOf('\n  }', rootStart)
  const scope = GLOBALS_CSS.slice(rootStart, rootEnd)
  const match = scope.match(new RegExp(`--${name}:\\s*([^;]+);`))
  expect(match, `--${name} is not declared in :root`).not.toBeNull()
  return match![1].trim()
}

/** The resolved `--primary` red as a hex string, e.g. `#ed2c2c`. */
function resolvedPrimaryHex(): string {
  const value = rootToken('primary')
  const match = value.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/)
  expect(match, `--primary is not an "H S% L%" triplet (got "${value}")`).not.toBeNull()
  return hslToHex(Number(match![1]), Number(match![2]), Number(match![3]))
}

/** The pixel dimensions declared in a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file)
  expect(
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    `${path.basename(file)} is not a PNG`
  ).toBe(true)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('public/manifest.webmanifest', () => {
  it('is valid JSON declaring every field required for installation', () => {
    // Requirement 11.1.
    expect(manifest.name).toBe('Boxing Rounds Timer')
    expect(manifest.short_name).toBe('Boxing Timer')
    expect(manifest.start_url).toBe('/')
    expect(manifest.display).toBe('standalone')
    expect(manifest.orientation).toBe('portrait')
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/)
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('declares 192, 512 and maskable-512 icon entries', () => {
    // Requirement 11.1: the three entries an installable manifest needs.
    const icons = manifest.icons ?? []
    expect(icons.length).toBeGreaterThanOrEqual(3)

    const any192 = icons.find((i) => i.sizes === '192x192' && i.purpose !== 'maskable')
    const any512 = icons.find((i) => i.sizes === '512x512' && i.purpose !== 'maskable')
    const maskable512 = icons.find(
      (i) => i.sizes === '512x512' && (i.purpose ?? '').split(' ').includes('maskable')
    )

    for (const [label, icon] of [
      ['192x192', any192],
      ['512x512', any512],
      ['maskable 512x512', maskable512],
    ] as const) {
      expect(icon, `no ${label} icon entry in the manifest`).toBeDefined()
      expect(icon!.type).toBe('image/png')
      expect(icon!.src.startsWith('/'), `${label} src must be root-relative`).toBe(true)
    }
  })

  it('references only icon files that exist on disk at their declared size', () => {
    // Requirement 11.1: an entry pointing at a missing file fails installation silently.
    const icons = manifest.icons ?? []
    expect(icons.length).toBeGreaterThan(0)

    for (const icon of icons) {
      const file = path.join(PUBLIC, icon.src.replace(/^\//, ''))
      expect(existsSync(file), `manifest icon ${icon.src} does not exist in public/`).toBe(true)

      const [declaredWidth, declaredHeight] = icon.sizes.split('x').map(Number)
      const actual = pngSize(file)
      expect(actual.width, `${icon.src} width`).toBe(declaredWidth)
      expect(actual.height, `${icon.src} height`).toBe(declaredHeight)
    }
  })

  it('declares a theme_color equal to the resolved --primary red', () => {
    // Requirement 11.10.
    expect(manifest.theme_color).toBe(resolvedPrimaryHex())
  })

  it('declares a background_color equal to the resolved dark --background', () => {
    // Requirement 11.1: the splash background matches the app's default (dark) theme.
    const darkStart = GLOBALS_CSS.indexOf('.dark {')
    const darkScope = GLOBALS_CSS.slice(darkStart, GLOBALS_CSS.indexOf('\n  }', darkStart))
    const match = darkScope.match(/--background:\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%;/)
    expect(match, '.dark --background is not an "H S% L%" triplet').not.toBeNull()
    expect(manifest.background_color).toBe(
      hslToHex(Number(match![1]), Number(match![2]), Number(match![3]))
    )
  })
})

describe('app/layout.tsx PWA metadata', () => {
  it('links the manifest and the Apple standalone metadata', () => {
    // Requirement 11.2.
    expect(LAYOUT).toContain("manifest: '/manifest.webmanifest'")
    expect(LAYOUT).toContain('appleWebApp')
    expect(LAYOUT).toContain('capable: true')
    expect(LAYOUT).toContain('statusBarStyle')
    expect(LAYOUT).toContain('/icons/apple-touch-icon.png')
    expect(LAYOUT).toMatch(/themeColor:\s*'#[0-9a-f]{6}'/)
  })

  it('sets a theme-color identical to the manifest theme_color', () => {
    // Requirement 11.10: one red, declared in three places, kept in lockstep here.
    const match = LAYOUT.match(/themeColor:\s*'(#[0-9a-f]{6})'/)
    expect(match, 'no themeColor in the viewport export').not.toBeNull()
    expect(match![1]).toBe(manifest.theme_color)
    expect(match![1]).toBe(resolvedPrimaryHex())
  })

  it('references an apple-touch-icon that exists on disk', () => {
    // Requirement 11.2.
    expect(existsSync(path.join(PUBLIC, 'icons', 'apple-touch-icon.png'))).toBe(true)
  })
})

describe('public/sw.js', () => {
  /**
   * `sw.js` with its comments removed.
   *
   * The negative assertions below are about what the worker *does*, and `sw.js` documents the
   * `cache.addAll` trap it deliberately avoids — so a raw substring search would match the
   * prose explaining the decision and fail on correct code. Stripping comments first keeps the
   * assertion aimed at the implementation. Safe for this file: it contains no string literal
   * holding `//` (every URL in it is root-relative).
   */
  const SW_CODE = SW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

  /** The body of a top-level `async function name(...) { ... }` declaration. */
  function functionBody(name: string): string {
    const start = SW_SOURCE.indexOf(`async function ${name}(`)
    expect(start, `sw.js declares no async function \`${name}\``).toBeGreaterThanOrEqual(0)
    const open = SW_SOURCE.indexOf('{', start)
    let depth = 0
    for (let i = open; i < SW_SOURCE.length; i += 1) {
      if (SW_SOURCE[i] === '{') depth += 1
      else if (SW_SOURCE[i] === '}') {
        depth -= 1
        if (depth === 0) return SW_SOURCE.slice(open, i + 1)
      }
    }
    throw new Error(`unbalanced braces in \`${name}\``)
  }

  it('routes /api/ requests to a network-only handler', () => {
    // Requirement 11.6: the network is attempted first for `/api/`.
    expect(SW_SOURCE).toContain("url.pathname.startsWith('/api/')")

    const apiRoute = SW_SOURCE.slice(
      SW_SOURCE.indexOf("url.pathname.startsWith('/api/')"),
      SW_SOURCE.indexOf("url.pathname.startsWith('/api/')") + 200
    )
    expect(apiRoute).toContain('event.respondWith(networkOnly(request))')
  })

  it('propagates /api/ failures instead of substituting a cached response', () => {
    // Requirement 11.7: the client must see the failure so the repository falls back to
    // local-only mode. A `catch` or a `caches` lookup in this handler would swallow it.
    const body = functionBody('networkOnly')
    expect(body).toContain('fetch(request)')
    expect(body).not.toContain('caches')
    expect(body).not.toContain('catch')
  })

  it('pre-caches the app shell and the bundled sounds without failing atomically', () => {
    // Requirement 11.4. `cache.addAll` rejects as a unit, so one absent sound asset — the
    // current state of `public/sounds/` — would abort the install and leave no offline shell.
    expect(SW_CODE).not.toContain('addAll')
    expect(SW_CODE).toContain('cacheIfAvailable')

    for (const asset of [
      '/manifest.webmanifest',
      '/icons/icon-192.png',
      '/sounds/boxing-bell.mp3',
      '/sounds/air-horn.mp3',
      '/sounds/buzzer.mp3',
      '/sounds/beep.mp3',
    ]) {
      expect(SW_SOURCE, `sw.js does not pre-cache ${asset}`).toContain(`'${asset}'`)
    }
  })

  it('serves a cached document when a navigation fails offline', () => {
    // Requirement 11.5: the timer screen still launches with no network.
    const body = functionBody('navigate')
    expect(body).toContain('cache.match(OFFLINE_DOCUMENT)')
    expect(SW_SOURCE).toContain("const OFFLINE_DOCUMENT = '/'")
  })
})
