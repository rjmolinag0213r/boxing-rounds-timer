/**
 * Rendering assertions for the sound settings view (tasks 8.5, 8.7).
 *
 * The interesting claims are structural: one selector per role, a preview and an upload
 * control per role, the volume slider and mute switch, and the background-audio notice —
 * each reachable by an accessible name, because that is what requirements 10.8 and 3.2 ask
 * for and what a screen-reader user actually gets.
 *
 * jsdom has neither Web Audio nor IndexedDB, so the engine degrades to its no-op path;
 * that is precisely the environment the guards were written for.
 *
 * **Validates: Requirements 3.2, 4.8, 10.8**
 */

import { act, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import SoundSettings from '@/app/_components/sound-settings'
import { SOUND_ROLE_LABELS, SOUND_ROLES } from '@/lib/audio/types'

describe('SoundSettings', () => {
  beforeAll(() => {
    // Radix's slider thumb measures itself with ResizeObserver, which jsdom lacks.
    if (typeof globalThis.ResizeObserver === 'undefined') {
      globalThis.ResizeObserver = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      } as unknown as typeof ResizeObserver
    }
  })

  beforeEach(async () => {
    window.localStorage.clear()
    await act(async () => {
      render(<SoundSettings />)
    })
  })

  it('offers a selector, a preview and an upload control for every role', () => {
    // Requirements 3.2, 10.8.
    for (const role of SOUND_ROLES) {
      const label = SOUND_ROLE_LABELS[role]
      expect(screen.getByRole('combobox', { name: `Sound for ${label}` })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: `Preview ${label}` })).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: `Upload a sound for ${label}` })
      ).toBeInTheDocument()
    }
  })

  it('exposes the volume slider and the mute switch by name', () => {
    // Requirements 3.8, 3.9, 10.8.
    expect(screen.getByRole('slider', { name: 'Volume' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Mute all sounds' })).toBeInTheDocument()
  })

  it('repeats the timer view’s background-audio limitation notice', () => {
    // Requirement 4.8.
    expect(screen.getByText(/iOS suspends web audio/i)).toBeInTheDocument()
  })

  it('shows an empty state until something is uploaded', () => {
    expect(screen.getByText(/No uploads yet/i)).toBeInTheDocument()
  })
})
