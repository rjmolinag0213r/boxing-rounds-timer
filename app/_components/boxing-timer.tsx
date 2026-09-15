'use client'

/**
 * The timer view.
 *
 * This component holds **no countdown state**. Every displayed timing value — the
 * countdown digits, the phase label, the round number and the progress ring — is derived
 * from the `TimerSnapshot` produced by `useTimerEngine`, which computes it purely from
 * wall-clock time (requirements 1.11, 1.12, 2.12). The old `setInterval` tick loop is
 * gone: it drifted and froze whenever iOS Safari throttled or suspended the tab.
 *
 * Audio goes through the configurable `SoundEngine` (`lib/audio/soundEngine.ts`), never
 * through `lib/audio.ts` directly, so the user's per-role assignments, volume and mute
 * apply to every sound this view produces (requirement 3.3). The AudioContext is unlocked
 * and resumed inside the Start gesture (requirement 4.1); each segment's end boundary and
 * its final-seconds warning ticks are pre-scheduled on the audio clock the moment the
 * segment becomes active (requirements 4.2, 4.3); and a hidden→visible transition resumes
 * the context and re-schedules only the boundaries still in the future
 * (requirements 4.4, 4.5).
 *
 * Colours are entirely token-driven: every brand accent resolves from `--primary` through
 * semantic utilities (`text-primary`, `stroke-primary`, `bg-primary/10`, `ring-primary/30`),
 * so light and dark mode are decided in `app/globals.css` with no component-level colour
 * branching (requirements 9.7, 9.8, 9.12, 9.14).
 *
 * Saved workouts are loaded into the configuration — rounds, round duration, rest duration and
 * prep duration — only after `stop()` returns the engine to `idle`, which is the one status in
 * which it adopts a new spec (requirement 5.8). Deleting a workout rewrites the workout list
 * alone and never touches recorded sessions (requirement 5.9).
 *
 * Requirements: 1.11, 1.12, 2.12, 3.3, 4.1, 4.2, 4.3, 4.5, 4.6, 4.7, 5.8, 5.9, 9.7, 9.8,
 * 9.10, 9.11, 9.12, 9.14
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Play,
  Pause,
  Square,
  RotateCcw,
  Bell,
  BellRing,
  Coffee,
  Info,
  Volume2,
  VolumeX,
  Settings2,
  Save,
  Trash2,
  Dumbbell,
  ListChecks,
  Check,
  Trophy,
  SlidersHorizontal,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { DurationField, NumberStepper } from '@/app/_components/workout-inputs'
import SoundSettings from '@/app/_components/sound-settings'
import { toast } from 'sonner'
import { useSoundSettings } from '@/lib/audio/useSoundSettings'
import type { SoundRole } from '@/lib/audio/types'
import { segmentAt } from '@/lib/timer/compute'
import type { Segment, WorkoutSpec } from '@/lib/timer/types'
import { useTimerEngine, type TimerSoundEvent } from '@/lib/timer/useTimerEngine'
import {
  DEFAULT_PREP_SECONDS,
  DEFAULT_PRESETS,
  formatSeconds,
  generateId,
  loadPresets,
  savePresets,
  workoutTypeLabel,
  type Preset,
  type WorkoutType,
} from '@/lib/presets'

/** The phases the view paints. `paused` is rendered with its underlying segment's accent. */
type VisualPhase = 'idle' | 'prep' | 'round' | 'rest' | 'finished'

/** The accent classes one phase paints itself with. All reds come from `--primary`. */
type PhaseAccent = {
  /** Large type (the countdown, ≥ 18 px) — red may be the full-strength `--primary`. */
  text: string
  /** Type below 18 px — red uses the darker `--accent-foreground` (requirement 9.10). */
  smallText: string
  /** The progress-ring stroke. */
  ring: string
  /** The page background tint gradient's `from-*` stop. */
  tint: string
}

/**
 * Per-phase accents (requirement 9.11). `round` is the brand red (`--primary`, hue 0) and
 * `rest` is a cool green ~160° away in hue, so the "am I working or recovering?" glance is
 * unmistakable mid-workout — and stays legible for colour-vision-deficient users. `prep`
 * is a muted slate ("about to start") and `finished` is a celebratory amber.
 *
 * Red is never hardcoded here: `text-primary`, `stroke-primary` and `from-primary/10`
 * resolve through the token system, so the light/dark blocks in `globals.css` are the
 * single source of truth (requirements 9.7, 9.12, 9.14).
 */
const PHASE_ACCENTS: Record<VisualPhase, PhaseAccent> = {
  idle: {
    text: 'text-muted-foreground',
    smallText: 'text-muted-foreground',
    ring: 'stroke-muted-foreground/50',
    tint: 'from-transparent to-transparent',
  },
  prep: {
    text: 'text-slate-500 dark:text-slate-300',
    smallText: 'text-slate-600 dark:text-slate-300',
    ring: 'stroke-slate-400',
    tint: 'from-slate-500/10 via-transparent to-transparent',
  },
  round: {
    text: 'text-primary',
    smallText: 'text-accent-foreground',
    ring: 'stroke-primary',
    tint: 'from-primary/10 via-transparent to-transparent',
  },
  rest: {
    text: 'text-emerald-500 dark:text-emerald-400',
    smallText: 'text-emerald-700 dark:text-emerald-400',
    ring: 'stroke-emerald-500',
    tint: 'from-emerald-500/10 via-transparent to-transparent',
  },
  finished: {
    text: 'text-amber-500 dark:text-amber-400',
    smallText: 'text-amber-700 dark:text-amber-400',
    ring: 'stroke-amber-500',
    tint: 'from-amber-500/10 via-transparent to-transparent',
  },
}

/** The rest accent applied to the rest-duration field's icon, matching `PHASE_ACCENTS.rest`. */
const REST_ICON_CLASS = 'text-emerald-500 dark:text-emerald-400'

/** Stable identity for a segment, used as the sound engine's de-duplication key. */
const segmentKeyOf = (segment: Segment): string => `${segment.kind}#${segment.index}`

/**
 * The sound role a segment's *start* announces.
 *
 * The timer engine's event roles and the sound engine's roles overlap but are not the same
 * set: the engine has `prepStart` (which is deliberately silent — the lead-in is announced
 * by a toast) while the sound layer has `warningTick` (which is pre-scheduled, never
 * emitted as a transition). This is the explicit mapping between them.
 */
function soundRoleForSegment(segment: Segment | undefined): SoundRole | null {
  if (!segment) return null
  if (segment.kind === 'rest') return 'restStart'
  if (segment.kind === 'round') return 'roundStart'
  return null
}

/** `true` only when the Notifications API exists and the user has already granted it. */
function notificationsGranted(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    window.Notification.permission === 'granted'
  )
}

/**
 * Posts a best-effort visual notification for a transition into `round` or `rest`
 * (requirement 4.7). Silently does nothing without granted permission.
 */
function postPhaseNotification(kind: 'round' | 'rest', round: number, totalRounds: number): void {
  if (!notificationsGranted()) return
  try {
    const title = kind === 'round' ? `Round ${round} of ${totalRounds}` : `Rest after round ${round}`
    new window.Notification(title, {
      body: kind === 'round' ? 'Hands up — work.' : 'Breathe and recover.',
      tag: `boxing-timer-${kind}-${round}`,
      silent: true,
    })
  } catch {
    // Notification constructors throw on some platforms (notably iOS Safari); ignore.
  }
}

const specKeyOf = (spec: WorkoutSpec): string =>
  `${spec.prepSeconds}|${spec.rounds}|${spec.roundSeconds}|${spec.restSeconds}`

export default function BoxingTimer() {
  // Configuration
  const [roundMinutes, setRoundMinutes] = useState<number>(3)
  const [roundSeconds, setRoundSeconds] = useState<number>(0)
  const [restMinutes, setRestMinutes] = useState<number>(1)
  const [restSecondsField, setRestSecondsField] = useState<number>(0)
  const [totalRounds, setTotalRounds] = useState<number>(12)
  /**
   * The lead-in before round 1. Part of the configuration (not a constant) so that loading
   * a saved workout can carry its own prep duration into the spec — MMA defaults use 10 s
   * where the boxing defaults use 5 s (requirement 5.8).
   */
  const [prepSeconds, setPrepSeconds] = useState<number>(DEFAULT_PREP_SECONDS)

  // Runtime (no countdown state here — see the module docblock)
  /**
   * Mute lives in the sound engine, not here: it is persisted alongside the volume and the
   * four role assignments, and the settings dialog toggles the very same value
   * (requirements 3.6, 3.9).
   */
  const { engine: soundEngine, muted, toggleMuted } = useSoundSettings()
  const [soundSettingsOpen, setSoundSettingsOpen] = useState<boolean>(false)
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >('unsupported')

  // Presets
  const [presets, setPresetsState] = useState<Preset[]>([])
  const [presetName, setPresetName] = useState<string>('')
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  /**
   * The workout family the loaded workout came from, so re-saving the configuration keeps
   * its Boxing/MMA identity instead of silently demoting it to `CUSTOM` (requirement 5.8).
   */
  const [activeType, setActiveType] = useState<WorkoutType>('CUSTOM')

  // Load presets from localStorage on mount
  useEffect(() => {
    const saved = loadPresets()
    if (saved && saved.length > 0) {
      setPresetsState(saved)
    } else {
      setPresetsState(DEFAULT_PRESETS)
    }
  }, [])

  // Reflect the current notification permission so the opt-in control can be offered.
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    setNotificationPermission(window.Notification.permission)
  }, [])

  const roundTotal = useMemo(
    () => Math.max(1, (roundMinutes ?? 0) * 60 + (roundSeconds ?? 0)),
    [roundMinutes, roundSeconds]
  )
  const restTotal = useMemo(
    () => Math.max(0, (restMinutes ?? 0) * 60 + (restSecondsField ?? 0)),
    [restMinutes, restSecondsField]
  )

  const spec = useMemo<WorkoutSpec>(
    () => ({
      prepSeconds: Math.max(0, prepSeconds ?? 0),
      rounds: Math.max(1, totalRounds ?? 1),
      roundSeconds: roundTotal,
      restSeconds: restTotal,
    }),
    [prepSeconds, totalRounds, roundTotal, restTotal]
  )

  /**
   * Announces a transition through the sound engine and posts its notification.
   *
   * The timer engine guarantees at most one event per reconciliation, so a resume that
   * crossed several boundaries while backgrounded produces one sound, not a burst
   * (requirement 2.10). The de-duplication key is the landed segment's identity — the same
   * key the pre-scheduled boundary sound carries — so a boundary that already sounded off
   * the audio clock is *not* repeated when this event arrives a moment later
   * (requirements 4.2, 4.4).
   */
  const handleSoundEvent = useCallback(
    (event: TimerSoundEvent) => {
      const rounds = Math.max(1, totalRounds ?? 1)
      const round = event.segment.index

      if (event.role === 'finished') {
        soundEngine.play('finished', 'finished')
        toast.success('Workout complete! Great job.', { icon: '🏆' })
        return
      }

      const role = soundRoleForSegment(event.segment)
      // `prepStart` maps to no sound role: the lead-in is announced by a toast.
      if (role) soundEngine.play(role, segmentKeyOf(event.segment))

      if (event.role === 'roundStart') postPhaseNotification('round', round, rounds)
      else if (event.role === 'restStart') postPhaseNotification('rest', round, rounds)
    },
    [totalRounds, soundEngine]
  )

  const {
    snapshot,
    status,
    spec: engineSpec,
    plan,
    start,
    pause,
    resume,
    stop,
  } = useTimerEngine({ spec, onSoundEvent: handleSoundEvent })

  const isRunning = status === 'running'
  const isActive = status === 'running' || status === 'paused'

  // A finished workout keeps its plan, so editing the configuration afterwards has to
  // return the engine to `idle` before the new spec can be adopted.
  const specKey = specKeyOf(spec)
  const engineSpecKey = specKeyOf(engineSpec)
  useEffect(() => {
    if (status === 'finished' && specKey !== engineSpecKey) stop()
  }, [status, specKey, engineSpecKey, stop])

  /* ---------------------------------------------------------------------- */
  /* Pre-scheduling on the audio clock (requirements 4.2, 4.3, 4.5)          */
  /* ---------------------------------------------------------------------- */

  /** The latest snapshot, read by effects that must not re-run every 250 ms tick. */
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  /** Bumped on every hidden→visible transition, to force a re-schedule. */
  const [resumeNonce, setResumeNonce] = useState<number>(0)

  /** The active segment's identity — stable for the whole segment, so effects key off it. */
  const activeSegmentKey = useMemo<string | null>(() => {
    if (status !== 'running') return null
    return segmentKeyOf(segmentAt(plan, snapshot.elapsedWorkoutMs).segment)
  }, [status, plan, snapshot.elapsedWorkoutMs])

  /**
   * Pre-schedules the active segment's end boundary and its warning ticks against the
   * AudioContext clock (requirement 4.2), which keeps firing under the render throttling a
   * backgrounded tab suffers. Runs once per segment, and again on every visibility resume —
   * where the engine drops every offset already in the past, so nothing sounds late
   * (requirements 4.4, 4.5).
   */
  useEffect(() => {
    soundEngine.cancelScheduled()
    if (status !== 'running' || activeSegmentKey === null) return

    const location = segmentAt(plan, snapshotRef.current.elapsedWorkoutMs)
    const position = plan.segments.indexOf(location.segment)
    const next = position >= 0 ? plan.segments[position + 1] : undefined

    soundEngine.scheduleSegment({
      kind: location.segment.kind,
      remainingMs: location.remainingMs,
      // No next segment means this boundary is the end of the workout.
      boundaryRole: next ? soundRoleForSegment(next) : 'finished',
      boundaryKey: next ? segmentKeyOf(next) : 'finished',
      tickKeyPrefix: activeSegmentKey,
    })

    return () => {
      soundEngine.cancelScheduled()
    }
  }, [soundEngine, status, activeSegmentKey, plan, resumeNonce])

  /**
   * Resumes the AudioContext and triggers a re-schedule when the tab comes back
   * (requirement 4.5). The timer engine reconciles the *clock* on the same event; this
   * handles the *audio*.
   */
  useEffect(() => {
    if (typeof document === 'undefined') return

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') return
      soundEngine.resume()
      setResumeNonce((nonce) => nonce + 1)
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [soundEngine])

  /* ---------------------------------------------------------------------- */
  /* Derived display values — all of them from the snapshot                  */
  /* ---------------------------------------------------------------------- */

  /** While paused the snapshot reports phase `paused`, so the accent comes from the plan. */
  const visualPhase = useMemo<VisualPhase>(() => {
    if (snapshot.phase !== 'paused') return snapshot.phase
    return segmentAt(plan, snapshot.elapsedWorkoutMs).segment.kind
  }, [snapshot, plan])

  /** While idle the ring shows the configured round length as a preview of the work ahead. */
  const idlePreviewMs = useMemo(
    () => plan.segments.find((segment) => segment.kind === 'round')?.durationMs ?? 0,
    [plan]
  )

  const displaySeconds = useMemo(() => {
    const ms = snapshot.phase === 'idle' ? idlePreviewMs : snapshot.remainingMs
    return Math.ceil(ms / 1000)
  }, [snapshot, idlePreviewMs])

  const progressPct = snapshot.progressPct

  const phaseLabel = useMemo(() => {
    if (snapshot.phase === 'paused') return 'PAUSED'
    if (visualPhase === 'prep') return 'GET READY'
    if (visualPhase === 'round') return `ROUND ${snapshot.currentRound}`
    if (visualPhase === 'rest') return 'REST'
    if (visualPhase === 'finished') return 'FINISHED'
    return 'READY'
  }, [snapshot.phase, snapshot.currentRound, visualPhase])

  const accent = PHASE_ACCENTS[visualPhase]

  /** The countdown accent — large type, so the full-strength red is safe here. */
  const phaseColorClass = accent.text

  /** The phase badge accent — `text-xs`, so red drops to `--accent-foreground`. */
  const phaseBadgeColorClass = accent.smallText

  const ringColorClass = accent.ring

  const bgTintClass = accent.tint

  const phaseCaption = useMemo(() => {
    if (snapshot.phase === 'paused') return 'Paused'
    if (visualPhase === 'idle') return 'Ready when you are'
    if (visualPhase === 'prep') return 'Starting soon'
    if (visualPhase === 'round') return 'Work'
    if (visualPhase === 'rest') return 'Recover'
    return 'All rounds done'
  }, [snapshot.phase, visualPhase])

  /* ---------------------------------------------------------------------- */
  /* Controls                                                               */
  /* ---------------------------------------------------------------------- */

  const handleStart = useCallback(() => {
    // Requirement 4.1: unlock and resume the AudioContext inside the user gesture — the
    // only moment iOS Safari permits it.
    soundEngine.unlock()
    soundEngine.resume()

    if (status === 'paused') {
      resume()
      return
    }

    // A fresh run reuses the previous run's segment keys, so the "already sounded" record
    // has to be cleared or round 1 would be silenced by round 1 of the last workout.
    soundEngine.resetPlayback()
    start()
    toast('Get ready…', { icon: '🥊' })
  }, [status, resume, start, soundEngine])

  const handlePause = useCallback(() => {
    // Pausing must not leave the round's boundary sound armed on the audio clock.
    soundEngine.cancelScheduled()
    pause()
  }, [pause, soundEngine])

  const handleStop = useCallback(() => {
    soundEngine.resetPlayback()
    stop()
  }, [stop, soundEngine])

  const handleReset = useCallback(() => {
    soundEngine.resetPlayback()
    stop()
    toast('Timer reset')
  }, [stop, soundEngine])

  const handleEnableNotifications = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    try {
      const result = await window.Notification.requestPermission()
      setNotificationPermission(result)
      if (result === 'granted') toast.success('Phase notifications enabled')
    } catch {
      // Older Safari rejects the promise form; nothing else to do.
    }
  }, [])

  /* ---------------------------------------------------------------------- */
  /* Presets                                                                */
  /* ---------------------------------------------------------------------- */

  const handleSavePreset = useCallback(() => {
    const name = (presetName ?? '').trim()
    if (!name) {
      toast.error('Please enter a preset name')
      return
    }
    const newPreset: Preset = {
      id: generateId(),
      name,
      // Inherits the loaded workout's family; a hand-built configuration is `CUSTOM`.
      // The Workout Builder assigns BOXING/MMA explicitly.
      type: activeType,
      rounds: totalRounds,
      roundSeconds: roundTotal,
      restSeconds: restTotal,
      prepSeconds: Math.max(0, prepSeconds ?? 0),
      createdAt: Date.now(),
    }
    const next = [...(presets ?? []), newPreset]
    setPresetsState(next)
    savePresets(next)
    setPresetName('')
    setActivePresetId(newPreset.id)
    toast.success(`Saved “${name}”`)
  }, [presetName, totalRounds, roundTotal, restTotal, prepSeconds, activeType, presets])

  /**
   * Loads a saved workout into the active configuration (requirement 5.8).
   *
   * The engine only adopts a new spec while its status is `idle`, so `stop()` runs first;
   * the rounds, round duration, rest duration **and** prep duration then flow into the
   * `WorkoutSpec` through the configuration state on the next render.
   */
  const handleLoadPreset = useCallback(
    (p: Preset) => {
      if (!p) return
      const rM = Math.floor((p.roundSeconds ?? 0) / 60)
      const rS = (p.roundSeconds ?? 0) % 60
      const restM = Math.floor((p.restSeconds ?? 0) / 60)
      const restS = (p.restSeconds ?? 0) % 60
      setRoundMinutes(rM)
      setRoundSeconds(rS)
      setRestMinutes(restM)
      setRestSecondsField(restS)
      setTotalRounds(Math.max(1, p.rounds ?? 1))
      // A record stored before prep durations existed defaults to 5 s (requirement 5.10).
      setPrepSeconds(Math.max(0, p.prepSeconds ?? DEFAULT_PREP_SECONDS))
      setActiveType(p.type ?? 'CUSTOM')
      setActivePresetId(p.id)
      // Return the engine to idle so it adopts the loaded spec.
      soundEngine.resetPlayback()
      stop()
      toast.success(`Loaded “${p.name}”`)
    },
    [stop, soundEngine]
  )

  /**
   * Deletes a saved workout (requirement 5.9).
   *
   * Only the workout list is rewritten: session records live in their own store and are
   * never touched here, so history survives the deletion of the workout it came from.
   */
  const handleDeletePreset = useCallback(
    (id: string) => {
      const next = (presets ?? []).filter((p) => p?.id !== id)
      setPresetsState(next)
      savePresets(next)
      if (activePresetId === id) setActivePresetId(null)
      toast('Workout deleted')
    },
    [presets, activePresetId]
  )

  const clamp = (v: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Number.isFinite(v) ? Math.floor(v) : min))

  // SVG ring geometry
  const size = 320
  const stroke = 10
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - progressPct / 100)

  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      {/* Background tint */}
      <div className={`fixed inset-0 -z-10 bg-gradient-to-b ${bgTintClass} transition-colors duration-700`} />

      {/* Header */}
      <header className="sticky top-0 z-30 w-full backdrop-blur bg-background/70 border-b border-border/40">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
              <Bell className="w-4 h-4 text-primary" />
            </div>
            <span className="font-display font-semibold tracking-tight">Boxing Timer</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleMuted}
              aria-label={muted ? 'Unmute' : 'Mute'}
              className="gap-2"
            >
              {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              <span className="hidden sm:inline text-xs">{muted ? 'Muted' : 'Sound On'}</span>
            </Button>

            {/* Sound settings. Task 12.1 gives this a Drawer on mobile; a Dialog makes the
                feature usable today. */}
            <Dialog open={soundSettingsOpen} onOpenChange={setSoundSettingsOpen}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-2" aria-label="Sound settings">
                  <SlidersHorizontal className="w-4 h-4" />
                  <span className="hidden sm:inline text-xs">Sounds</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>Sounds</DialogTitle>
                  <DialogDescription>
                    Pick a sound for each moment of the workout, upload your own bell, and set the
                    volume.
                  </DialogDescription>
                </DialogHeader>
                <SoundSettings />
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] px-4 sm:px-6 py-8 sm:py-12">
        {/* Purpose statement */}
        <div className="text-center mb-8">
          <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight">
            Train by the <span className="text-primary">bell</span>.
          </h1>
          <p className="mt-2 text-sm sm:text-base text-muted-foreground">
            Configure rounds and rests, save presets, and let the timer keep you honest.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
          {/* Timer panel */}
          <Card className="relative p-6 sm:p-10 bg-card/60 backdrop-blur shadow-lg overflow-hidden">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={phaseLabel}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    transition={{ duration: 0.25 }}
                    className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold tracking-widest ${phaseBadgeColorClass} bg-foreground/5`}
                  >
                    {snapshot.phase === 'paused' ? (
                      <Pause className="w-3.5 h-3.5" />
                    ) : (
                      <>
                        {visualPhase === 'round' && <Bell className="w-3.5 h-3.5" />}
                        {visualPhase === 'rest' && <Coffee className="w-3.5 h-3.5" />}
                        {visualPhase === 'finished' && <Trophy className="w-3.5 h-3.5" />}
                        {visualPhase === 'prep' && <Dumbbell className="w-3.5 h-3.5" />}
                        {visualPhase === 'idle' && <Dumbbell className="w-3.5 h-3.5" />}
                      </>
                    )}
                    <span>{phaseLabel}</span>
                  </motion.div>
                </AnimatePresence>
              </div>
              <div className="text-xs sm:text-sm text-muted-foreground font-mono">
                Round{' '}
                <span className="text-foreground font-semibold">
                  {Math.min(snapshot.currentRound, snapshot.totalRounds)}
                </span>{' '}
                / {snapshot.totalRounds}
              </div>
            </div>

            {/* Circular timer */}
            <div className="flex items-center justify-center py-4">
              <div className="relative" style={{ width: size, height: size, maxWidth: '100%' }}>
                <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-full -rotate-90">
                  <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    strokeWidth={stroke}
                    className="stroke-foreground/10"
                    fill="none"
                  />
                  <motion.circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    strokeWidth={stroke}
                    className={`${ringColorClass} transition-colors duration-500`}
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    animate={{ strokeDashoffset: dashOffset }}
                    transition={{ duration: 0.9, ease: 'linear' }}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <div
                    className={`font-mono font-semibold tabular-nums tracking-tight ${phaseColorClass} text-6xl sm:text-7xl`}
                    role="timer"
                    aria-live="off"
                  >
                    {formatSeconds(displaySeconds)}
                  </div>
                  <div className="mt-2 text-xs uppercase tracking-[0.25em] text-muted-foreground">
                    {phaseCaption}
                  </div>
                </div>
              </div>
            </div>

            {/* Controls */}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              {!isRunning ? (
                // The stock default variant supplies bg-primary / text-primary-foreground
                // (requirement 9.8), so no color classes are set here.
                <Button size="lg" onClick={handleStart} className="gap-2 px-6 shadow-md">
                  <Play className="w-4 h-4" />
                  {status === 'paused' ? 'Resume' : 'Start Workout'}
                </Button>
              ) : (
                <Button
                  size="lg"
                  onClick={handlePause}
                  variant="secondary"
                  className="gap-2 px-6 shadow-md"
                >
                  <Pause className="w-4 h-4" />
                  Pause
                </Button>
              )}
              <Button
                size="lg"
                variant="outline"
                onClick={handleStop}
                className="gap-2 px-6"
                disabled={status === 'idle'}
              >
                <Square className="w-4 h-4" />
                Stop
              </Button>
              <Button size="lg" variant="ghost" onClick={handleReset} className="gap-2">
                <RotateCcw className="w-4 h-4" />
                Reset
              </Button>
            </div>

            {/* Background-audio limitation notice (requirement 4.6) */}
            <div className="mt-8 flex items-start gap-2.5 rounded-lg bg-foreground/[0.03] px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
              <div>
                <p>
                  <span className="font-semibold text-foreground">Background audio:</span> iOS
                  suspends web audio while the browser is backgrounded or the screen is locked, so
                  the bell and warning ticks will not sound during that time. The timer itself keeps
                  running on wall-clock time and stays accurate — it catches up to the correct round
                  and remaining time as soon as you return to the foreground.
                </p>
                {notificationPermission === 'default' && (
                  <Button
                    variant="link"
                    size="sm"
                    onClick={handleEnableNotifications}
                    className="h-auto p-0 mt-1 text-[11px] gap-1.5"
                  >
                    <BellRing className="w-3 h-3" />
                    Enable round notifications
                  </Button>
                )}
                {notificationPermission === 'granted' && (
                  <p className="mt-1 text-[11px]">
                    Round and rest notifications are on for this device.
                  </p>
                )}
              </div>
            </div>
          </Card>

          {/* Sidebar: Settings + Presets */}
          <div className="flex flex-col gap-6">
            {/* Settings */}
            <Card className="p-5 bg-card/60 backdrop-blur shadow-md">
              <div className="flex items-center gap-2 mb-4">
                <Settings2 className="w-4 h-4 text-primary" />
                <h2 className="font-display font-semibold tracking-tight">Settings</h2>
              </div>

              <div className="space-y-4">
                <NumberStepper
                  label="Rounds"
                  value={totalRounds}
                  min={1}
                  max={99}
                  onChange={(v) => setTotalRounds(clamp(v, 1, 99))}
                  disabled={isActive}
                />

                <DurationField
                  label="Round duration"
                  minutes={roundMinutes}
                  seconds={roundSeconds}
                  onChange={(m, s) => {
                    setRoundMinutes(clamp(m, 0, 59))
                    setRoundSeconds(clamp(s, 0, 59))
                  }}
                  disabled={isActive}
                  icon={<Bell className="w-3.5 h-3.5 text-primary" />}
                />

                <DurationField
                  label="Rest duration"
                  minutes={restMinutes}
                  seconds={restSecondsField}
                  onChange={(m, s) => {
                    setRestMinutes(clamp(m, 0, 59))
                    setRestSecondsField(clamp(s, 0, 59))
                  }}
                  disabled={isActive}
                  icon={<Coffee className={`w-3.5 h-3.5 ${REST_ICON_CLASS}`} />}
                />

                <NumberStepper
                  label="Prep countdown (sec)"
                  value={prepSeconds}
                  min={0}
                  max={60}
                  onChange={(v) => setPrepSeconds(clamp(v, 0, 60))}
                  disabled={isActive}
                />

                <div className="pt-2 text-xs text-muted-foreground flex items-center justify-between">
                  <span>Total time</span>
                  <span className="font-mono">
                    {formatSeconds(
                      Math.max(0, prepSeconds ?? 0) +
                        totalRounds * roundTotal +
                        Math.max(0, totalRounds - 1) * restTotal
                    )}
                  </span>
                </div>
              </div>
            </Card>

            {/* Presets */}
            <Card className="p-5 bg-card/60 backdrop-blur shadow-md">
              <div className="flex items-center gap-2 mb-4">
                <ListChecks className="w-4 h-4 text-primary" />
                <h2 className="font-display font-semibold tracking-tight">Presets</h2>
              </div>

              <div className="flex items-center gap-2 mb-4">
                <Input
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value ?? '')}
                  placeholder="Name this workout…"
                  className="h-9"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSavePreset()
                  }}
                />
                <Button size="sm" onClick={handleSavePreset} className="gap-1.5">
                  <Save className="w-3.5 h-3.5" />
                  Save
                </Button>
              </div>

              <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                <AnimatePresence initial={false}>
                  {(presets ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-6">
                      No presets saved yet.
                    </p>
                  ) : (
                    (presets ?? []).map((p) => {
                      const isActiveP = activePresetId === p?.id
                      return (
                        <motion.div
                          key={p?.id}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -6 }}
                          transition={{ duration: 0.2 }}
                          className={`group flex items-center justify-between gap-2 rounded-lg px-3 py-2.5 transition-colors ${
                            isActiveP
                              ? 'bg-primary/10 ring-1 ring-primary/30'
                              : 'bg-foreground/[0.03] hover:bg-foreground/[0.06]'
                          }`}
                        >
                          <button
                            onClick={() => handleLoadPreset(p)}
                            className="flex-1 text-left min-w-0"
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              {isActiveP && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
                              <span className="text-sm font-medium truncate">{p?.name ?? 'Untitled'}</span>
                              <span className="ml-auto flex-shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {workoutTypeLabel(p?.type)}
                              </span>
                            </div>
                            <div className="mt-0.5 text-[11px] text-muted-foreground font-mono">
                              {p?.rounds ?? 0} × {formatSeconds(p?.roundSeconds ?? 0)}
                              <span className="mx-1.5 opacity-50">·</span>
                              rest {formatSeconds(p?.restSeconds ?? 0)}
                            </div>
                          </button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => handleDeletePreset(p?.id ?? '')}
                            aria-label="Delete preset"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        </motion.div>
                      )
                    })
                  )}
                </AnimatePresence>
              </div>
            </Card>
          </div>
        </div>

        <footer className="mt-12 text-center text-xs text-muted-foreground">
          <p>Tip: audio unlocks after you press Start. The countdown stays accurate even if you switch apps.</p>
        </footer>
      </main>
    </div>
  )
}
