'use client'

/**
 * React binding for the sound engine's settings.
 *
 * The engine is the single source of truth (it owns persistence), so the hook mirrors it
 * rather than holding a copy: it subscribes on mount and re-renders whenever the settings
 * change from anywhere. That is what keeps the header's mute button and the settings
 * dialog's mute switch showing the same thing (requirements 3.3, 3.6, 3.8, 3.9).
 *
 * Requirements: 3.3, 3.6, 3.8, 3.9
 */

import { useCallback, useEffect, useState } from 'react'

import { getSoundEngine, type SoundEngine } from './soundEngine'
import { defaultSoundSettings, type SoundRole, type SoundSettings, type SoundSource } from './types'

export interface UseSoundSettingsResult {
  engine: SoundEngine
  settings: SoundSettings
  muted: boolean
  volume: number
  setMuted: (muted: boolean) => void
  toggleMuted: () => void
  setVolume: (volume: number) => void
  assign: (role: SoundRole, source: SoundSource) => void
}

export function useSoundSettings(): UseSoundSettingsResult {
  const engine = getSoundEngine()
  /**
   * The first render deliberately reports the *defaults* rather than the persisted
   * settings: the server has no `localStorage`, so rendering the restored values here
   * would make the client's first pass disagree with the server's HTML. The mount effect
   * below adopts the real settings before the browser paints.
   */
  const [settings, setSettings] = useState<SoundSettings>(defaultSoundSettings)

  useEffect(() => {
    setSettings(engine.getSettings())
    return engine.subscribe(setSettings)
  }, [engine])

  const setMuted = useCallback((muted: boolean) => engine.setMuted(muted), [engine])
  const toggleMuted = useCallback(
    () => engine.setMuted(!engine.getSettings().muted),
    [engine]
  )
  const setVolume = useCallback((volume: number) => engine.setVolume(volume), [engine])
  const assign = useCallback(
    (role: SoundRole, source: SoundSource) => engine.assign(role, source),
    [engine]
  )

  return {
    engine,
    settings,
    muted: settings.muted,
    volume: settings.volume,
    setMuted,
    toggleMuted,
    setVolume,
    assign,
  }
}
