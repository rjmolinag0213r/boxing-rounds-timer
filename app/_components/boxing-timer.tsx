'use client'

/**
 * The timer panel.
 *
 * This is one tab of `boxing-app.tsx`, which owns the page chrome (header, tabs, sound
 * settings). Everything here is the timer itself: the countdown, its controls, the round
 * configuration and the saved-workout list.
 *
 * The layout is mobile-first (requirement 10). Start, Pause and Stop each clear a 44 × 44 CSS
 * pixel touch target; below 640 px the primary action fills the container width and sits above
 * the secondary controls (requirements 10.3, 10.4); the countdown is monospaced with tabular
 * numerals and grows from `text-5xl` below 640 px to `text-8xl` at 1024 px and up
 * (requirement 10.5); and below 640 px the round configuration moves out of the side panel into
 * a bottom-sheet drawer (requirement 10.9). Every framer-motion duration is capped under
 * `prefers-reduced-motion: reduce` (requirement 10.7).
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
 * alone and never touches recorded sessions (requirement 5.9). That list comes from
 * `lib/data/workoutLibrary.ts` — the *shared* store, not a private copy — so a workout saved in
 * the Builder tab appears here immediately and neither view can overwrite the other's writes.
 *
 * Requirements: 1.11, 1.12, 2.12, 3.3, 4.1, 4.2, 4.3, 4.5, 4.6, 4.7, 5.8, 5.9, 9.7, 9.8,
 * 9.10, 9.11, 9.12, 9.14, 10.3, 10.4, 10.5, 10.7, 10.9, 10.11
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
  Settings2,
  Save,
  Trash2,
  Dumbbell,
  ListChecks,
  Check,
  Trophy,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer'
import { DurationField, NumberStepper } from '@/app/_components/workout-inputs'
import { toast } from 'sonner'
import { useSoundSettings } from '@/lib/audio/useSoundSettings'
import type { SoundRole } from '@/lib/audio/types'
import { getWorkoutRepository } from '@/lib/data/repositoryClient'
import { useWorkoutLibrary } from '@/lib/data/workoutLibrary'
import { buildSessionRecord } from '@/lib/data/sessionRecording'
import { motionDurationSeconds, motionOffset, usePrefersReducedMotion } from '@/lib/ui/motion'
import { useIsMobileViewport } from '@/lib/ui/useMediaQuery'
import { segmentAt } from '@/lib/timer/compute'
import type { Segment, TimelinePlan, WorkoutSpec } from '@/lib/timer/types'
import { useTimerEngine, type TimerSoundEvent } from '@/lib/timer/useTimerEngine'
import {
  DEFAULT_PREP_SECONDS,
  formatSeconds,
  generateId,
  workoutTypeLabel,
  type Preset,
  type WorkoutType,
} from '@/lib/presets'

/**
 * The minimum touch target requirement 10.3 sets for Start, Pause and Stop, as the utilities
 * that realise it. Exported so the accessibility test asserts the same value the view uses.
 */
export const TOUCH_TARGET_CLASS = 'min-h-[44px] min-w-[44px]'

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
  const { engine: soundEngine } = useSoundSettings()
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >('unsupported')

  /** Reduced-motion preference, applied to every framer-motion duration below (req 10.7). */
  const reducedMotion = usePrefersReducedMotion()
  /** Below 640 px the round configuration lives in a bottom sheet (requirement 10.9). */
  const isMobile = useIsMobileViewport()
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false)

  // Presets — the shared library, so the Builder tab and this panel cannot diverge.
  const { workouts: presets, saveWorkout, deleteWorkout } = useWorkoutLibrary()
  const [presetName, setPresetName] = useState<string>('')
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  /**
   * The workout family the loaded workout came from, so re-saving the configuration keeps
   * its Boxing/MMA identity instead of silently demoting it to `CUSTOM` (requirement 5.8).
   */
  const [activeType, setActiveType] = useState<WorkoutType>('CUSTOM')

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

  /* ---------------------------------------------------------------------- */
  /* Session recording (requirements 6.1, 6.2, 6.3, 6.4)                     */
  /* ---------------------------------------------------------------------- */

  /** Wall-clock start of the current run; `null` whenever no run is in progress. */
  const runStartedAtRef = useRef<number | null>(null)
  /** Guards against recording the same run twice (finish, then the stop that follows). */
  const runRecordedRef = useRef<boolean>(false)
  /** The active plan and the engine's latest effective elapsed time, for the stop path. */
  const planRef = useRef<TimelinePlan | null>(null)
  const elapsedRef = useRef<number>(0)

  /** The name stored on the session — the loaded workout's, or a generic label. */
  const activeWorkoutName = useMemo<string>(() => {
    const loaded = (presets ?? []).find((p) => p?.id === activePresetId)
    return loaded?.name ?? 'Custom workout'
  }, [presets, activePresetId])

  /**
   * Records the run that just ended.
   *
   * `finished` counts every planned round; a stop counts only the `round` segments that fully
   * elapsed (requirement 6.2). The duration is the engine's effective elapsed time, which has
   * already had every paused interval removed (requirement 6.3) — at the finish that is exactly
   * `plan.totalMs`. Name and type are copied onto the record, so deleting the workout later
   * leaves history intact (requirement 6.4).
   */
  const recordRun = useCallback(
    (outcome: 'finished' | 'stopped') => {
      const startedAtMs = runStartedAtRef.current
      const activePlan = planRef.current
      if (startedAtMs === null || activePlan === null || runRecordedRef.current) return

      runRecordedRef.current = true
      runStartedAtRef.current = null

      const completed = outcome === 'finished'
      const record = buildSessionRecord({
        id: generateId(),
        workoutId: activePresetId,
        workoutName: activeWorkoutName,
        type: activeType,
        plan: activePlan,
        elapsedMs: completed ? activePlan.totalMs : elapsedRef.current,
        completed,
        startedAtMs,
        endedAtMs: Date.now(),
      })

      // Local-first: the repository has the record before the network is involved, so a
      // failure here only concerns *syncing* (requirements 6.7, 8.2, 8.10).
      void getWorkoutRepository()
        .recordSession(record)
        .catch(() => {
          toast.error('This session was saved on this device but could not be synced.')
        })
    },
    [activePresetId, activeWorkoutName, activeType]
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
        // The engine emits `finished` exactly once per run, which makes it the recording
        // trigger for a completed workout (requirement 6.1).
        recordRun('finished')
        toast.success('Workout complete! Great job.', { icon: '🏆' })
        return
      }

      const role = soundRoleForSegment(event.segment)
      // `prepStart` maps to no sound role: the lead-in is announced by a toast.
      if (role) soundEngine.play(role, segmentKeyOf(event.segment))

      if (event.role === 'roundStart') postPhaseNotification('round', round, rounds)
      else if (event.role === 'restStart') postPhaseNotification('rest', round, rounds)
    },
    [totalRounds, soundEngine, recordRun]
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

  // Kept current for the session recorder, which runs from callbacks defined above the
  // engine (requirement 6.3 — the duration it reads is the engine's effective elapsed time).
  planRef.current = plan
  elapsedRef.current = snapshot.elapsedWorkoutMs

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
    // The run's own start timestamp, stored on the session record (requirement 6.1).
    runStartedAtRef.current = Date.now()
    runRecordedRef.current = false
    start()
    toast('Get ready…', { icon: '🥊' })
  }, [status, resume, start, soundEngine])

  const handlePause = useCallback(() => {
    // Pausing must not leave the round's boundary sound armed on the audio clock.
    soundEngine.cancelScheduled()
    pause()
  }, [pause, soundEngine])

  /**
   * Ends the current run.
   *
   * A run stopped before the engine reached `finished` is still recorded, with `completed`
   * false and only the fully elapsed rounds counted (requirement 6.2). Recording happens
   * *before* `stop()`, which resets the engine's elapsed time to 0.
   */
  const endRun = useCallback(() => {
    recordRun('stopped')
    soundEngine.resetPlayback()
    stop()
  }, [recordRun, soundEngine, stop])

  const handleStop = useCallback(() => {
    endRun()
  }, [endRun])

  const handleReset = useCallback(() => {
    endRun()
    toast('Timer reset')
  }, [endRun])

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
    // Through the shared library: the Builder tab sees this workout on its next render, and
    // an account mirrors it (requirements 8.2, 10.1).
    void saveWorkout(newPreset)
    setPresetName('')
    setActivePresetId(newPreset.id)
    // Requirement 10.11: a saved workout is confirmed by a transient toast.
    toast.success(`Saved “${name}”`)
  }, [presetName, totalRounds, roundTotal, restTotal, prepSeconds, activeType, saveWorkout])

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
      // Return the engine to idle so it adopts the loaded spec. Loading a workout mid-run
      // ends that run, so it is recorded as a stop (requirement 6.2).
      endRun()
      toast.success(`Loaded “${p.name}”`)
    },
    [endRun]
  )

  /**
   * Deletes a saved workout (requirement 5.9).
   *
   * Only the workout list is rewritten: session records live in their own store and are
   * never touched here, so history survives the deletion of the workout it came from.
   */
  const handleDeletePreset = useCallback(
    (id: string) => {
      void deleteWorkout(id)
      if (activePresetId === id) setActivePresetId(null)
      toast('Workout deleted')
    },
    [deleteWorkout, activePresetId]
  )

  const clamp = (v: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Number.isFinite(v) ? Math.floor(v) : min))

  // SVG ring geometry
  const size = 320
  const stroke = 10
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - progressPct / 100)


  /**
   * The round configuration. Rendered in the side panel at 640 px and up, and inside the
   * bottom-sheet drawer below it (requirement 10.9) — one definition, so the two presentations
   * cannot drift apart, and only ever one of them mounted, so no control's accessible name is
   * duplicated in the accessibility tree.
   */
  const settingsFields = (
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
        <span className="font-mono tabular-nums">
          {formatSeconds(
            Math.max(0, prepSeconds ?? 0) +
              totalRounds * roundTotal +
              Math.max(0, totalRounds - 1) * restTotal
          )}
        </span>
      </div>
    </div>
  )

  return (
    <>
      {/* Background tint — the whole page glows with the active phase's accent. */}
      <div
        className={`fixed inset-0 -z-10 bg-gradient-to-b ${bgTintClass} transition-colors duration-700 motion-reduce:transition-none`}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        {/* Timer panel */}
        <Card className="relative p-4 sm:p-6 lg:p-10 bg-card/60 backdrop-blur shadow-lg overflow-hidden">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <AnimatePresence mode="wait">
                <motion.div
                  key={phaseLabel}
                  initial={{ opacity: 0, y: motionOffset(-4, reducedMotion) }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: motionOffset(4, reducedMotion) }}
                  transition={{ duration: motionDurationSeconds(0.25, reducedMotion) }}
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
            <div className="text-xs sm:text-sm text-muted-foreground font-mono tabular-nums">
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
                  className={`${ringColorClass} transition-colors duration-500 motion-reduce:transition-none`}
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  animate={{ strokeDashoffset: dashOffset }}
                  transition={{
                    duration: motionDurationSeconds(0.9, reducedMotion),
                    ease: 'linear',
                  }}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                {/*
                  Requirement 10.5: monospaced with tabular numerals so the digits never shift
                  width, and a size that steps up across the breakpoints — text-5xl below
                  640 px, text-8xl from 1024 px.
                */}
                <div
                  className={`font-mono font-semibold tabular-nums tracking-tight ${phaseColorClass} text-5xl sm:text-6xl lg:text-8xl`}
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

          {/*
            Controls (requirements 10.3, 10.4). Below 640 px this is a column: the primary
            action fills the container width on its own row, with the secondary controls beneath
            it. From 640 px up the three sit on one centred row.
          */}
          <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center">
            {!isRunning ? (
              // The stock default variant supplies bg-primary / text-primary-foreground
              // (requirement 9.8), so no color classes are set here.
              <Button
                size="lg"
                onClick={handleStart}
                className={`w-full gap-2 px-6 shadow-md sm:w-auto ${TOUCH_TARGET_CLASS}`}
              >
                <Play className="w-4 h-4" />
                {status === 'paused' ? 'Resume' : 'Start Workout'}
              </Button>
            ) : (
              <Button
                size="lg"
                onClick={handlePause}
                variant="secondary"
                className={`w-full gap-2 px-6 shadow-md sm:w-auto ${TOUCH_TARGET_CLASS}`}
              >
                <Pause className="w-4 h-4" />
                Pause
              </Button>
            )}

            <div className="flex items-center justify-center gap-3 sm:contents">
              <Button
                size="lg"
                variant="outline"
                onClick={handleStop}
                className={`flex-1 gap-2 px-6 sm:flex-none ${TOUCH_TARGET_CLASS}`}
                disabled={status === 'idle'}
              >
                <Square className="w-4 h-4" />
                Stop
              </Button>
              <Button
                size="lg"
                variant="ghost"
                onClick={handleReset}
                className={`flex-1 gap-2 sm:flex-none ${TOUCH_TARGET_CLASS}`}
              >
                <RotateCcw className="w-4 h-4" />
                Reset
              </Button>
            </div>
          </div>

          {/* Below 640 px the configuration is a bottom sheet, not a side panel (req 10.9) */}
          {isMobile && (
            <Drawer open={settingsOpen} onOpenChange={setSettingsOpen}>
              <DrawerTrigger asChild>
                <Button
                  variant="outline"
                  className={`mt-3 w-full gap-2 ${TOUCH_TARGET_CLASS}`}
                  aria-label="Timer settings"
                >
                  <Settings2 className="w-4 h-4" />
                  Timer settings
                </Button>
              </DrawerTrigger>
              <DrawerContent className="max-h-[85vh]">
                <DrawerHeader>
                  <DrawerTitle>Timer settings</DrawerTitle>
                  <DrawerDescription>
                    Rounds, round and rest durations, and the lead-in countdown.
                  </DrawerDescription>
                </DrawerHeader>
                <div className="overflow-y-auto px-4 pb-8">{settingsFields}</div>
              </DrawerContent>
            </Drawer>
          )}

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

        {/* Sidebar: Settings (640 px and up) + Presets */}
        <div className="flex flex-col gap-6">
          {!isMobile && (
            <Card className="p-5 bg-card/60 backdrop-blur shadow-md">
              <div className="flex items-center gap-2 mb-4">
                <Settings2 className="w-4 h-4 text-primary" />
                <h2 className="font-display font-semibold tracking-tight">Settings</h2>
              </div>
              {settingsFields}
            </Card>
          )}

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
                aria-label="Preset name"
                className="h-10"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSavePreset()
                }}
              />
              <Button onClick={handleSavePreset} className="gap-1.5" aria-label="Save preset">
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
                        initial={{ opacity: 0, y: motionOffset(6, reducedMotion) }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: motionOffset(-6, reducedMotion) }}
                        transition={{ duration: motionDurationSeconds(0.2, reducedMotion) }}
                        className={`group flex items-center justify-between gap-2 rounded-lg px-3 py-2 transition-colors motion-reduce:transition-none ${
                          isActiveP
                            ? 'bg-primary/10 ring-1 ring-primary/30'
                            : 'bg-foreground/[0.03] hover:bg-foreground/[0.06]'
                        }`}
                      >
                        <button
                          onClick={() => handleLoadPreset(p)}
                          aria-label={`Load ${p?.name ?? 'Untitled'}`}
                          className={`flex-1 min-w-0 rounded-md px-1 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${TOUCH_TARGET_CLASS}`}
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            {isActiveP && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
                            <span className="text-sm font-medium truncate">{p?.name ?? 'Untitled'}</span>
                            <span className="ml-auto flex-shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                              {workoutTypeLabel(p?.type)}
                            </span>
                          </div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground font-mono tabular-nums">
                            {p?.rounds ?? 0} × {formatSeconds(p?.roundSeconds ?? 0)}
                            <span className="mx-1.5 opacity-50">·</span>
                            rest {formatSeconds(p?.restSeconds ?? 0)}
                          </div>
                        </button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-10 w-10 flex-shrink-0 opacity-60 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
                          onClick={() => handleDeletePreset(p?.id ?? '')}
                          aria-label={`Delete ${p?.name ?? 'preset'}`}
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
    </>
  )
}
