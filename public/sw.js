/* eslint-disable no-restricted-globals */
/**
 * The offline service worker.
 *
 * Scope of the job (requirements 11.4–11.7, 11.11):
 *
 * - **Install** pre-caches the app shell and the bundled audio under `/sounds/` (11.4).
 * - **Offline** launches serve the timer screen from cache, so the wall-clock engine, the
 *   synthesized sounds and the locally stored workouts all keep working with no network (11.5).
 * - **`/api/*`** is network-first and its failures are *propagated*, never masked with a cached
 *   or synthetic response — the client repository needs to see the failure to fall back to
 *   local-only mode (11.6, 11.7).
 * - **Updates** install in the background and take over on the next launch (11.11).
 *
 * Written by hand rather than generated: the whole policy is three routes, and hand-writing it
 * keeps the `/api/` propagation rule explicit and reviewable.
 *
 * Bump `VERSION` whenever the shell or the asset list changes. The old cache is deleted in
 * `activate`, so a version bump is what evicts stale HTML.
 */

/*
 * Bump this on any deploy that changes the shell or the asset list.
 *
 * `activate` deletes every `boxing-timer-*` cache that is not the current one, so this
 * constant is the ONLY thing that evicts stale HTML and chunks. Leaving it pinned meant a
 * previously-installed worker kept serving the old app after a deploy — the bug this bump
 * fixes. `ServiceWorkerRegistrar` additionally calls `registration.update()` on mount so a
 * new version is discovered without waiting for the browser's own 24h check.
 */
const VERSION = 'v2'
const CACHE = `boxing-timer-${VERSION}`

/**
 * The document served for any navigation while offline. The timer lives at `/`, which also
 * hosts the builder and history tabs, so one entry covers every route the app has.
 */
const OFFLINE_DOCUMENT = '/'

/**
 * Everything worth having before the first offline launch.
 *
 * The `/sounds/*` entries are the registry in `lib/audio/builtins.ts`. This repository ships
 * no audio files (see `public/sounds/README.md`), so most of them 404 today — which is exactly
 * why each asset is cached **individually** below and a failure is ignored. `cache.addAll()`
 * rejects atomically: one missing file would abort the whole install and leave the app with no
 * offline shell at all.
 */
const PRECACHE_URLS = [
  OFFLINE_DOCUMENT,
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/sounds/boxing-bell.mp3',
  '/sounds/air-horn.mp3',
  '/sounds/buzzer.mp3',
  '/sounds/beep.mp3',
]

/** Caches one URL, swallowing 404s and network errors. Returns nothing either way. */
async function cacheIfAvailable(cache, url) {
  try {
    // `reload` skips the HTTP cache so a fresh worker version pre-caches fresh bytes.
    const response = await fetch(new Request(url, { cache: 'reload' }))
    if (response && (response.ok || response.type === 'opaque')) {
      await cache.put(url, response)
    }
  } catch {
    // Absent bundled sound, offline install, blocked request: the app degrades gracefully
    // (the Sound_Engine falls back to its synthesized tone), so this is not fatal.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await Promise.all(PRECACHE_URLS.map((url) => cacheIfAvailable(cache, url)))
      // Requirement 11.11: the new version becomes the waiting worker and takes over on the
      // next launch. `skipWaiting()` is deliberately NOT called — swapping the worker under a
      // running workout could replace the page's chunks mid-round.
    })()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names.filter((name) => name.startsWith('boxing-timer-') && name !== CACHE).map((name) => caches.delete(name))
      )
      await self.clients.claim()
    })()
  )
})

/**
 * Network-first, no fallback (requirements 11.6, 11.7).
 *
 * A successful response is returned as-is and never cached: workouts and sessions are already
 * mirrored in IndexedDB by the repository, and a cached API response would let a stale list
 * silently overwrite fresher local state. A failure rethrows, so `fetch()` rejects in the page
 * and the repository switches to local-only mode.
 */
async function networkOnly(request) {
  return fetch(request)
}

/**
 * Cache-first for immutable build output and static assets, refreshing the entry in the
 * background when the network answers.
 */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response && response.ok && response.type === 'basic') {
    cache.put(request, response.clone()).catch(() => {})
  }
  return response
}

/**
 * Navigations are network-first so a fresh deploy wins, with the cached document as the
 * offline fallback (requirement 11.5).
 */
async function navigate(request) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (response && response.ok && response.type === 'basic') {
      cache.put(OFFLINE_DOCUMENT, response.clone()).catch(() => {})
    }
    return response
  } catch (error) {
    const cached = (await cache.match(request)) || (await cache.match(OFFLINE_DOCUMENT))
    if (cached) return cached
    throw error
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request

  // Never touch non-GET traffic: POST/PUT/DELETE go to `/api/*` and must reach the server.
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Cross-origin requests (Google Fonts, the host script tag) are left to the browser.
  if (url.origin !== self.location.origin) return

  // Requirement 11.6: attempt the network first for `/api/`, and requirement 11.7: let the
  // failure through untouched.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkOnly(request))
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigate(request))
    return
  }

  event.respondWith(cacheFirst(request))
})

/** Lets the page ask a waiting worker to take over immediately (used by the update toast). */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})
