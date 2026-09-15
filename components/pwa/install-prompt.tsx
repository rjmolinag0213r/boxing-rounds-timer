'use client'

/**
 * The two install affordances, mounted once from `app/layout.tsx`.
 *
 * - **Where `beforeinstallprompt` fires** (Chromium: Android, desktop Chrome/Edge) the browser's
 *   own mini-infobar is suppressed and a custom "Install app" control is shown instead, which
 *   hands the stashed event back to the browser on click (requirement 11.8).
 * - **On iOS Safari, outside standalone mode**, no such event exists, so the user is shown the
 *   manual recipe — Share, then "Add to Home Screen" — as a dismissible card. Dismissing it
 *   records the choice in `localStorage`, so it appears at most once per browser profile
 *   (requirement 11.9).
 *
 * Neither appears once the app is installed and running standalone, and nothing at all renders
 * on the server or before the effects run — so this never shifts the timer's layout on load.
 *
 * Requirements: 11.8, 11.9
 */

import { useCallback, useEffect, useState } from 'react'
import { Download, Share, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  markInstallHintDismissed,
  shouldShowIosInstallHint,
  type BeforeInstallPromptEvent,
} from '@/lib/pwa/installState'

/** Bottom-anchored, clear of the notch and the home indicator, above the page but under toasts. */
const DOCK_CLASS =
  'fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] ' +
  'pointer-events-none'

export function InstallPrompt() {
  /** The stashed Chromium event. Non-null means the browser can install the app right now. */
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIosHint, setShowIosHint] = useState<boolean>(false)

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event): void => {
      // Suppress Chromium's mini-infobar so the custom control is the only affordance.
      event.preventDefault()
      setInstallEvent(event as BeforeInstallPromptEvent)
    }
    const onInstalled = (): void => {
      setInstallEvent(null)
      setShowIosHint(false)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  useEffect(() => {
    // Decided on the client only: the server has no user agent and no `localStorage`.
    setShowIosHint(shouldShowIosInstallHint())
  }, [])

  const install = useCallback(async (): Promise<void> => {
    if (!installEvent) return
    try {
      await installEvent.prompt()
    } catch {
      // The event is single-use; a rejected `prompt()` means it is spent either way.
    }
    // Whether the user accepted or dismissed, this event cannot be reused. Chromium fires a
    // fresh `beforeinstallprompt` on a later visit if the app is still not installed.
    setInstallEvent(null)
  }, [installEvent])

  const dismissIosHint = useCallback((): void => {
    markInstallHintDismissed()
    setShowIosHint(false)
  }, [])

  if (installEvent) {
    return (
      <div className={DOCK_CLASS}>
        <Button
          type="button"
          onClick={install}
          className="pointer-events-auto min-h-[44px] gap-2 shadow-lg"
          aria-label="Install app"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Install app
        </Button>
      </div>
    )
  }

  if (showIosHint) {
    return (
      <div className={DOCK_CLASS}>
        <div
          role="region"
          aria-label="Add to Home Screen"
          className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg"
        >
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <Share className="h-4 w-4 text-primary" aria-hidden="true" />
          </div>
          <p className="flex-1 text-xs leading-relaxed sm:text-sm">
            Install the timer: tap <span className="font-semibold">Share</span>, then{' '}
            <span className="font-semibold">Add to Home Screen</span>. It then opens full screen
            and works offline.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={dismissIosHint}
            aria-label="Dismiss install hint"
            className="min-h-[44px] min-w-[44px] shrink-0"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    )
  }

  return null
}
