/**
 * The three questions the install affordances need answered, kept out of the component so
 * they can be asserted directly.
 *
 * 1. Is the app already running installed? Nothing should be offered then.
 * 2. Is this iOS Safari? It never fires `beforeinstallprompt`, so it needs the manual
 *    Share → "Add to Home Screen" hint instead (requirement 11.9).
 * 3. Has the user already dismissed that hint in this browser profile? It must not come back
 *    (requirement 11.9's "at most once per browser profile after dismissal").
 *
 * Every browser access is guarded: these run during render on the client and are imported by
 * a module that Next.js also evaluates on the server.
 *
 * Requirements: 11.8, 11.9
 */

/**
 * Where the dismissal is remembered. `localStorage` *is* the browser profile: it is
 * origin-scoped, survives restarts, and is not shared with another profile or a private
 * window — precisely the persistence requirement 11.9 asks for.
 */
export const IOS_HINT_DISMISSED_KEY = 'boxing-timer:install-hint-dismissed'

/**
 * The `beforeinstallprompt` event, which TypeScript's DOM lib does not declare because it is
 * not in any standard — it is a Chromium extension (requirement 11.8).
 */
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
  prompt(): Promise<void>
}

/** `true` when the page is running as an installed app rather than in a browser tab. */
export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false
  try {
    // The standard signal, plus `minimal-ui` which iOS reports for some install paths.
    if (typeof window.matchMedia === 'function') {
      if (window.matchMedia('(display-mode: standalone)').matches) return true
      if (window.matchMedia('(display-mode: minimal-ui)').matches) return true
    }
  } catch {
    // A stubbed `matchMedia` that throws on an unknown feature: fall through to Safari's flag.
  }
  // iOS Safari's own non-standard flag, which predates `display-mode` support there.
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true
}

/**
 * `true` for Safari on iOS or iPadOS.
 *
 * Every iOS browser renders with WebKit and reports "Safari" in its user agent, but only real
 * Safari has the Share → "Add to Home Screen" flow the hint describes, so Chrome (`CriOS`),
 * Firefox (`FxiOS`), Edge (`EdgiOS`) and Opera (`OPiOS`) on iOS are excluded. iPadOS 13+
 * masquerades as desktop Macintosh, and is told apart by its touch points.
 */
export function isIosSafari(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false

  const ua = navigator.userAgent || ''
  const isIosDevice = /iPad|iPhone|iPod/.test(ua)
  const isIpadOsDesktopMode = ua.includes('Macintosh') && (navigator.maxTouchPoints ?? 0) > 1
  if (!isIosDevice && !isIpadOsDesktopMode) return false

  // A non-Safari iOS browser, or an in-app web view (which cannot install anything at all).
  if (/CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|GSA/.test(ua)) return false

  return ua.includes('Safari')
}

/** `true` once the user has dismissed the add-to-home-screen hint in this profile. */
export function hasDismissedInstallHint(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(IOS_HINT_DISMISSED_KEY) === '1'
  } catch {
    // Private mode / storage disabled: treat as "not dismissed" so the hint still helps once,
    // which is the best available behaviour when the decision cannot be remembered.
    return false
  }
}

/** Remembers the dismissal. Silent when storage is unavailable. */
export function markInstallHintDismissed(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(IOS_HINT_DISMISSED_KEY, '1')
  } catch {
    // Nothing to do: the hint is dismissed for this page view either way.
  }
}

/**
 * Should the iOS hint be shown right now (requirement 11.9)?
 *
 * All three conditions must hold: iOS Safari, not already installed, not already dismissed.
 */
export function shouldShowIosInstallHint(): boolean {
  return isIosSafari() && !isStandaloneDisplay() && !hasDismissedInstallHint()
}
