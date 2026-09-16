'use client'

/**
 * Registers `public/sw.js` so the app can launch with no network (requirements 11.4–11.7).
 *
 * Mounted once from `app/layout.tsx`. It renders nothing — every effect is a side effect on
 * `navigator.serviceWorker`.
 *
 * **Production only.** A cache-first worker in front of the dev server's hot-reloaded chunks
 * is a chunk-load error waiting to happen (the same failure `ChunkLoadErrorHandler` mops up),
 * so in development this instead *unregisters* any worker a previous production build left
 * behind on `localhost`.
 *
 * **Updates land on the next launch (requirement 11.11).** A new worker installs in the
 * background and parks in `waiting`; it is never forced to activate under a running workout,
 * which would swap the page's chunks mid-round. The user gets an unobtrusive toast offering to
 * apply it now — taking it posts `SKIP_WAITING` and reloads once the new worker takes control.
 * Ignoring the toast is fine: the worker activates by itself on the next cold start.
 *
 * Requirements: 11.4, 11.5, 11.6, 11.7, 11.11
 */

import { useEffect } from 'react'
import { toast } from 'sonner'

/** Where the worker lives and the scope it claims. */
const SW_URL = '/sw.js'

export function ServiceWorkerRegistrar(): null {
  useEffect(() => {
    // jsdom and older browsers expose no `serviceWorker` at all.
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

    const container = navigator.serviceWorker

    if (process.env.NODE_ENV !== 'production') {
      // Clear out a worker from an earlier production build on the same origin.
      container
        .getRegistrations()
        .then((registrations) => registrations.forEach((registration) => registration.unregister()))
        .catch(() => {})
      return
    }

    let cancelled = false
    let reloading = false

    /** Offers the waiting version. Reloads only after the new worker is in control. */
    const offerUpdate = (waiting: ServiceWorker): void => {
      if (cancelled) return
      toast('A new version is ready', {
        description: 'It will be used the next time you open the app.',
        action: {
          label: 'Reload now',
          onClick: () => {
            reloading = true
            waiting.postMessage('SKIP_WAITING')
          },
        },
      })
    }

    const onControllerChange = (): void => {
      // Only reload when the user asked for it; an unprompted reload could interrupt a round.
      if (reloading) window.location.reload()
    }

    container.addEventListener('controllerchange', onControllerChange)

    container
      .register(SW_URL, { scope: '/' })
      .then((registration) => {
        if (cancelled) return

        // Ask the browser to re-fetch `sw.js` now rather than on its own schedule (up to
        // 24h). Without this, a deploy could go unnoticed for a day on an installed PWA,
        // which is exactly how a stale shell survives a release.
        registration.update().catch(() => {})

        // A version was already waiting when this page loaded.
        if (registration.waiting && container.controller) offerUpdate(registration.waiting)

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          if (!installing) return
          installing.addEventListener('statechange', () => {
            // `controller` is null on the very first install — that is not an *update*.
            if (installing.state === 'installed' && container.controller) offerUpdate(installing)
          })
        })
      })
      .catch(() => {
        // Registration fails on insecure origins, with cookies disabled, or in private modes.
        // The app is fully functional online without a worker, so this stays silent.
      })

    return () => {
      cancelled = true
      container.removeEventListener('controllerchange', onControllerChange)
    }
  }, [])

  return null
}
