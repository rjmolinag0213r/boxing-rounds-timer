/**
 * The bundled sound registry.
 *
 * Each entry names an asset the app *may* ship under `public/sounds/`. The registry is
 * deliberately independent of whether the file is actually present in a given deployment:
 * `lib/audio/soundEngine.ts` fetches the asset lazily and, if the fetch or decode fails —
 * a 404 in a build that did not bundle the audio, a partial cache, an offline first
 * visit — plays the role's synthesized tone instead (requirements 3.2, 3.7).
 *
 * See `public/sounds/README.md` for the attribution policy and for what this repository
 * does and does not bundle.
 *
 * Requirements: 3.2, 3.7
 */

import type { SynthId } from './types'

/** One selectable bundled asset. */
export interface BuiltinSound {
  /** Public URL path, resolved relative to the deployment root. */
  assetPath: string
  /** Display name shown in the settings selector. */
  name: string
  /**
   * The synth tone this asset imitates. Used only for the "(bundled)" label copy and for
   * previewing intent — the *playback* fallback is always the role's own synth tone, per
   * requirement 3.7.
   */
  resembles: SynthId
}

/** The bundled assets, in display order (requirement 3.2). */
export const BUILTIN_SOUNDS: readonly BuiltinSound[] = [
  { assetPath: '/sounds/boxing-bell.mp3', name: 'Boxing bell (bundled)', resembles: 'bell' },
  { assetPath: '/sounds/air-horn.mp3', name: 'Air horn (bundled)', resembles: 'airhorn' },
  { assetPath: '/sounds/buzzer.mp3', name: 'Buzzer (bundled)', resembles: 'buzzer' },
  { assetPath: '/sounds/beep.mp3', name: 'Beep (bundled)', resembles: 'beep' },
]

/** `true` when `assetPath` is a registered bundled asset. */
export function isBuiltinAsset(assetPath: string): boolean {
  return BUILTIN_SOUNDS.some((sound) => sound.assetPath === assetPath)
}

/** The display name for a bundled asset path, or the path itself when unregistered. */
export function builtinName(assetPath: string): string {
  return BUILTIN_SOUNDS.find((sound) => sound.assetPath === assetPath)?.name ?? assetPath
}
