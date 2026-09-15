/**
 * The install affordances: the Chromium install control and the iOS add-to-home-screen hint.
 *
 * **Validates: Requirements 11.8, 11.9**
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { InstallPrompt } from '@/components/pwa/install-prompt'
import { IOS_HINT_DISMISSED_KEY } from '@/lib/pwa/installState'

/** jsdom's default user agent, restored after each test. */
const DEFAULT_UA = window.navigator.userAgent

const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
}

/** Dispatches a `beforeinstallprompt` carrying a spy `prompt()`, as Chromium would. */
function fireBeforeInstallPrompt(): { prompt: ReturnType<typeof vi.fn> } {
  const prompt = vi.fn().mockResolvedValue(undefined)
  const event = new Event('beforeinstallprompt', { cancelable: true })
  Object.assign(event, { prompt, platforms: ['web'], userChoice: Promise.resolve({}) })
  act(() => {
    window.dispatchEvent(event)
  })
  return { prompt }
}

beforeEach(() => {
  window.localStorage.clear()
  setUserAgent(DEFAULT_UA)
})

afterEach(() => {
  cleanup()
  setUserAgent(DEFAULT_UA)
  window.localStorage.clear()
})

describe('InstallPrompt', () => {
  it('renders nothing on a browser that neither fires the event nor is iOS Safari', () => {
    const { container } = render(<InstallPrompt />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows an install control once beforeinstallprompt fires and triggers the browser prompt', async () => {
    // Requirement 11.8.
    render(<InstallPrompt />)
    expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument()

    const { prompt } = fireBeforeInstallPrompt()

    const button = screen.getByRole('button', { name: 'Install app' })
    await act(async () => {
      fireEvent.click(button)
    })
    expect(prompt).toHaveBeenCalledTimes(1)

    // The event is single-use, so the control retires with it.
    expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument()
  })

  it('suppresses the browser mini-infobar by cancelling the event', () => {
    // Requirement 11.8: the custom control replaces the default UI rather than doubling it.
    render(<InstallPrompt />)
    const event = new Event('beforeinstallprompt', { cancelable: true })
    Object.assign(event, { prompt: vi.fn() })
    act(() => {
      window.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
  })

  it('hides the install control once the app reports itself installed', () => {
    // Requirement 11.8: nothing to install any more.
    render(<InstallPrompt />)
    fireBeforeInstallPrompt()
    expect(screen.getByRole('button', { name: 'Install app' })).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new Event('appinstalled'))
    })
    expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument()
  })

  it('shows the Share then Add to Home Screen hint on iOS Safari outside standalone mode', () => {
    // Requirement 11.9.
    setUserAgent(IPHONE_SAFARI_UA)
    render(<InstallPrompt />)

    const hint = screen.getByRole('region', { name: 'Add to Home Screen' })
    expect(hint).toHaveTextContent(/Share/)
    expect(hint).toHaveTextContent(/Add to Home Screen/)
  })

  it('never shows the hint when already running installed', () => {
    // Requirement 11.9's "not running in standalone display mode" precondition.
    setUserAgent(IPHONE_SAFARI_UA)
    Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true })
    try {
      const { container } = render(<InstallPrompt />)
      expect(container).toBeEmptyDOMElement()
    } finally {
      Object.defineProperty(window.navigator, 'standalone', {
        value: undefined,
        configurable: true,
      })
    }
  })

  it('shows the hint at most once per browser profile after dismissal', () => {
    // Requirement 11.9.
    setUserAgent(IPHONE_SAFARI_UA)
    render(<InstallPrompt />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss install hint' }))
    expect(screen.queryByRole('region', { name: 'Add to Home Screen' })).not.toBeInTheDocument()
    expect(window.localStorage.getItem(IOS_HINT_DISMISSED_KEY)).toBe('1')

    // A later visit in the same profile: the dismissal is remembered.
    cleanup()
    const { container } = render(<InstallPrompt />)
    expect(container).toBeEmptyDOMElement()
  })

  it('does not show the iOS hint in a non-Safari iOS browser', () => {
    // Requirement 11.9 scopes the hint to iOS Safari; Chrome on iOS has no such Share flow.
    setUserAgent(IPHONE_SAFARI_UA.replace('Version/17.0', 'CriOS/120.0.0.0'))
    const { container } = render(<InstallPrompt />)
    expect(container).toBeEmptyDOMElement()
  })
})
