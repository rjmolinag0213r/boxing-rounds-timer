'use client'

/**
 * The sound settings view.
 *
 * One selector per role, listing every synthesized tone, every bundled asset and every
 * stored upload (requirement 3.2); a preview that plays the role's *assigned* source once
 * at the configured volume (requirement 3.10); a volume slider and a mute switch
 * (requirements 3.8, 3.9); per-role upload with validation feedback (requirements 3.4,
 * 3.5); and deletion for stored uploads, which returns any role that used the deleted file
 * to its synth tone (requirement 3.11).
 *
 * The engine owns the state and the persistence — this component only renders it and calls
 * into it, so the header's mute button and this switch can never disagree.
 *
 * Every interactive control carries a visible label or an `aria-label` (requirement 10.8)
 * and every colour resolves from a semantic token (requirement 10.10). The background-audio
 * notice repeats the timer view's wording verbatim, as requirement 4.8 asks.
 *
 * Requirements: 3.2, 3.4, 3.5, 3.8, 3.9, 3.10, 3.11, 4.8, 10.8, 10.10
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Info, Loader2, Play, Trash2, Upload, Volume1, VolumeX } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { BUILTIN_SOUNDS } from '@/lib/audio/builtins'
import { SoundUploadError, type CustomSoundMeta } from '@/lib/audio/customStore'
import { useSoundSettings } from '@/lib/audio/useSoundSettings'
import {
  decodeSoundSource,
  encodeSoundSource,
  SOUND_ROLE_HINTS,
  SOUND_ROLE_LABELS,
  SOUND_ROLES,
  SYNTH_IDS,
  SYNTH_LABELS,
  type SoundRole,
} from '@/lib/audio/types'

/** The upload constraints, spelled out for the user before they pick a file. */
const UPLOAD_HINT = 'Any audio file up to 5 MB and 10 seconds.'

export interface SoundSettingsProps {
  className?: string
}

export default function SoundSettings({ className }: SoundSettingsProps) {
  const { engine, settings, muted, volume, setMuted, setVolume, assign } = useSoundSettings()

  const [customSounds, setCustomSounds] = useState<CustomSoundMeta[]>([])
  /** The message from the last rejected upload, shown until the next attempt. */
  const [uploadError, setUploadError] = useState<string | null>(null)
  /** The role whose upload is in flight, so its button can show progress. */
  const [uploadingRole, setUploadingRole] = useState<SoundRole | null>(null)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const pendingRoleRef = useRef<SoundRole | null>(null)

  const refreshCustomSounds = useCallback(async () => {
    try {
      setCustomSounds(await engine.listCustom())
    } catch {
      setCustomSounds([])
    }
  }, [engine])

  // Requirement 3.11: a role pointing at an upload that is no longer in the store (cleared
  // browser data, a different device) returns to its synth tone before anything is drawn.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await engine.pruneMissingCustom()
      } catch {
        // ignore
      }
      if (!cancelled) await refreshCustomSounds()
    })()
    return () => {
      cancelled = true
    }
  }, [engine, refreshCustomSounds])

  /** Display label for a stored upload, with its duration. */
  const customLabel = useCallback(
    (meta: CustomSoundMeta): string => `${meta.name} (${meta.durationSeconds.toFixed(1)}s)`,
    []
  )

  const volumePercent = useMemo(() => Math.round(volume * 100), [volume])

  const handlePreview = useCallback(
    (role: SoundRole) => {
      // The click is a user gesture, which is the only moment iOS lets us start audio.
      engine.unlock()
      engine.resume()
      engine.play(role)
    },
    [engine]
  )

  const handlePickFile = useCallback((role: SoundRole) => {
    pendingRoleRef.current = role
    setUploadError(null)
    fileInputRef.current?.click()
  }, [])

  const handleFileChosen = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const role = pendingRoleRef.current
      const file = event.target.files?.[0] ?? null
      // Let the same file be re-picked after a rejection.
      event.target.value = ''
      if (!role || !file) return

      // Decoding needs a running AudioContext, and this handler is still inside the
      // user gesture that opened the picker.
      engine.unlock()
      setUploadingRole(role)
      setUploadError(null)
      try {
        await engine.loadCustom(role, file)
        await refreshCustomSounds()
        toast.success(`“${file.name}” assigned to ${SOUND_ROLE_LABELS[role]}`)
      } catch (error) {
        // Requirement 3.5: name the failed validation, keep every assignment as it was.
        const message =
          error instanceof SoundUploadError
            ? error.message
            : 'That file could not be stored. Please try another one.'
        setUploadError(message)
      } finally {
        setUploadingRole(null)
        pendingRoleRef.current = null
      }
    },
    [engine, refreshCustomSounds]
  )

  const handleDeleteCustom = useCallback(
    async (meta: CustomSoundMeta) => {
      try {
        await engine.deleteCustom(meta.blobId)
        await refreshCustomSounds()
        toast(`Deleted “${meta.name}”`)
      } catch {
        toast.error('That sound could not be deleted.')
      }
    },
    [engine, refreshCustomSounds]
  )

  const handleAssign = useCallback(
    (role: SoundRole, value: string) => {
      const source = decodeSoundSource(value)
      if (source) assign(role, source)
    },
    [assign]
  )

  return (
    <div className={className}>
      {/* A single hidden input serves every role's upload button. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={handleFileChosen}
      />

      {/* Output: volume + mute */}
      <div className="space-y-4 rounded-lg bg-foreground/[0.03] p-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="sound-mute" className="flex items-center gap-2 text-sm">
            <VolumeX className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Mute all sounds
          </Label>
          <Switch
            id="sound-mute"
            aria-label="Mute all sounds"
            checked={muted}
            onCheckedChange={(checked) => setMuted(checked === true)}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="sound-volume" className="flex items-center gap-2 text-sm">
              <Volume1 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Volume
            </Label>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {volumePercent}%
            </span>
          </div>
          <Slider
            id="sound-volume"
            aria-label="Volume"
            min={0}
            max={100}
            step={1}
            value={[volumePercent]}
            onValueChange={(next) => setVolume((next[0] ?? 0) / 100)}
            disabled={muted}
          />
        </div>
      </div>

      {/* Per-role assignment */}
      <div className="mt-5 space-y-5">
        {SOUND_ROLES.map((role) => {
          const source = settings.assignments[role]
          const value = encodeSoundSource(source)
          const roleLabel = SOUND_ROLE_LABELS[role]
          const isUploading = uploadingRole === role

          return (
            <div key={role} className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor={`sound-source-${role}`} className="text-sm font-medium">
                  {roleLabel}
                </Label>
                <span className="text-[11px] text-muted-foreground">{SOUND_ROLE_HINTS[role]}</span>
              </div>

              <div className="flex items-center gap-2">
                <Select value={value} onValueChange={(next) => handleAssign(role, next)}>
                  <SelectTrigger
                    id={`sound-source-${role}`}
                    aria-label={`Sound for ${roleLabel}`}
                    className="h-9 flex-1"
                  >
                    <SelectValue placeholder="Choose a sound" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Synthesized</SelectLabel>
                      {SYNTH_IDS.map((synthId) => (
                        <SelectItem key={synthId} value={`synth:${synthId}`}>
                          {SYNTH_LABELS[synthId]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    <SelectGroup>
                      <SelectLabel>Bundled</SelectLabel>
                      {BUILTIN_SOUNDS.map((builtin) => (
                        <SelectItem key={builtin.assetPath} value={`builtin:${builtin.assetPath}`}>
                          {builtin.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    {customSounds.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Your uploads</SelectLabel>
                        {customSounds.map((meta) => (
                          <SelectItem key={meta.blobId} value={`custom:${meta.blobId}`}>
                            {customLabel(meta)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>

                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-9 w-9 flex-shrink-0"
                  onClick={() => handlePreview(role)}
                  disabled={muted}
                  aria-label={`Preview ${roleLabel}`}
                  title={muted ? 'Unmute to preview' : `Preview ${roleLabel}`}
                >
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>

                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-9 w-9 flex-shrink-0"
                  onClick={() => handlePickFile(role)}
                  disabled={isUploading}
                  aria-label={`Upload a sound for ${roleLabel}`}
                  title={`Upload a sound for ${roleLabel}. ${UPLOAD_HINT}`}
                >
                  {isUploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Upload feedback (requirement 3.5) */}
      {uploadError && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span>{uploadError}</span>
        </div>
      )}

      {/* Stored uploads (requirement 3.11) */}
      <div className="mt-6">
        <h3 className="text-sm font-medium">Your uploads</h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{UPLOAD_HINT}</p>

        {customSounds.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            No uploads yet. Use the upload button next to any sound above.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {customSounds.map((meta) => (
              <li
                key={meta.blobId}
                className="flex items-center justify-between gap-2 rounded-lg bg-foreground/[0.03] px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-xs">{customLabel(meta)}</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 flex-shrink-0"
                  onClick={() => void handleDeleteCustom(meta)}
                  aria-label={`Delete ${meta.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The same background-audio notice the timer view shows (requirement 4.8) */}
      <div className="mt-6 flex items-start gap-2.5 rounded-lg bg-foreground/[0.03] px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        <p>
          <span className="font-semibold text-foreground">Background audio:</span> iOS suspends web
          audio while the browser is backgrounded or the screen is locked, so the bell and warning
          ticks will not sound during that time. The timer itself keeps running on wall-clock time
          and stays accurate — it catches up to the correct round and remaining time as soon as you
          return to the foreground.
        </p>
      </div>
    </div>
  )
}
