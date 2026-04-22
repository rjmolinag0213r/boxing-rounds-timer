'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Play,
  Pause,
  Square,
  RotateCcw,
  Bell,
  Coffee,
  Volume2,
  VolumeX,
  Settings2,
  Save,
  Trash2,
  Dumbbell,
  Plus,
  Minus,
  ListChecks,
  Check,
  Trophy,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { toast } from 'sonner'
import {
  unlockAudio,
  playRoundStartBell,
  playRestStartBuzzer,
  playWarningTick,
} from '@/lib/audio'
import {
  DEFAULT_PRESETS,
  formatSeconds,
  generateId,
  loadPresets,
  savePresets,
  type Preset,
} from '@/lib/presets'

type Phase = 'idle' | 'prep' | 'round' | 'rest' | 'finished'

const PREP_SECONDS = 5

export default function BoxingTimer() {
  // Configuration
  const [roundMinutes, setRoundMinutes] = useState<number>(3)
  const [roundSeconds, setRoundSeconds] = useState<number>(0)
  const [restMinutes, setRestMinutes] = useState<number>(1)
  const [restSecondsField, setRestSecondsField] = useState<number>(0)
  const [totalRounds, setTotalRounds] = useState<number>(12)

  // Runtime
  const [phase, setPhase] = useState<Phase>('idle')
  const [currentRound, setCurrentRound] = useState<number>(1)
  const [remaining, setRemaining] = useState<number>(180)
  const [running, setRunning] = useState<boolean>(false)
  const [muted, setMuted] = useState<boolean>(false)

  // Presets
  const [presets, setPresetsState] = useState<Preset[]>([])
  const [presetName, setPresetName] = useState<string>('')
  const [activePresetId, setActivePresetId] = useState<string | null>(null)

  // Interval ref
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mutedRef = useRef<boolean>(false)
  useEffect(() => {
    mutedRef.current = muted
  }, [muted])

  // Load presets from localStorage on mount
  useEffect(() => {
    const saved = loadPresets()
    if (saved && saved.length > 0) {
      setPresetsState(saved)
    } else {
      setPresetsState(DEFAULT_PRESETS)
    }
  }, [])

  const roundTotal = useMemo(
    () => Math.max(1, (roundMinutes ?? 0) * 60 + (roundSeconds ?? 0)),
    [roundMinutes, roundSeconds]
  )
  const restTotal = useMemo(
    () => Math.max(0, (restMinutes ?? 0) * 60 + (restSecondsField ?? 0)),
    [restMinutes, restSecondsField]
  )

  const phaseTotal = useMemo(() => {
    if (phase === 'round') return roundTotal
    if (phase === 'rest') return Math.max(1, restTotal)
    if (phase === 'prep') return PREP_SECONDS
    return roundTotal
  }, [phase, roundTotal, restTotal])

  const progressPct = useMemo(() => {
    if (phaseTotal <= 0) return 0
    const p = ((phaseTotal - remaining) / phaseTotal) * 100
    return Math.min(100, Math.max(0, p))
  }, [remaining, phaseTotal])

  const playSound = useCallback((type: 'roundStart' | 'restStart' | 'tick') => {
    if (mutedRef.current) return
    if (type === 'roundStart') playRoundStartBell()
    else if (type === 'restStart') playRestStartBuzzer()
    else playWarningTick()
  }, [])

  const clearTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  // Tick logic
  useEffect(() => {
    if (!running) {
      clearTimer()
      return
    }
    clearTimer()
    intervalRef.current = setInterval(() => {
      setRemaining((prev) => {
        const next = prev - 1
        // Warning ticks for last 3 seconds of round/rest
        if (next > 0 && next <= 3) {
          playSound('tick')
        }
        return next
      })
    }, 1000)
    return () => clearTimer()
  }, [running, clearTimer, playSound])

  // Phase transitions when remaining hits 0
  useEffect(() => {
    if (!running) return
    if (remaining > 0) return

    if (phase === 'prep') {
      // Start first round
      setPhase('round')
      setCurrentRound(1)
      setRemaining(roundTotal)
      playSound('roundStart')
      return
    }

    if (phase === 'round') {
      const isLast = currentRound >= totalRounds
      if (isLast) {
        setPhase('finished')
        setRunning(false)
        setRemaining(0)
        playSound('roundStart')
        toast.success('Workout complete! Great job.', { icon: '🏆' })
        return
      }
      if (restTotal <= 0) {
        // skip rest
        setCurrentRound((r) => r + 1)
        setPhase('round')
        setRemaining(roundTotal)
        playSound('roundStart')
        return
      }
      setPhase('rest')
      setRemaining(restTotal)
      playSound('restStart')
      return
    }

    if (phase === 'rest') {
      setCurrentRound((r) => r + 1)
      setPhase('round')
      setRemaining(roundTotal)
      playSound('roundStart')
      return
    }
  }, [remaining, running, phase, currentRound, totalRounds, roundTotal, restTotal, playSound])

  const handleStart = useCallback(() => {
    unlockAudio()
    if (phase === 'idle' || phase === 'finished') {
      setCurrentRound(1)
      setPhase('prep')
      setRemaining(PREP_SECONDS)
      setRunning(true)
      toast('Get ready…', { icon: '🥊' })
      return
    }
    setRunning(true)
  }, [phase])

  const handlePause = useCallback(() => {
    setRunning(false)
  }, [])

  const handleStop = useCallback(() => {
    setRunning(false)
    setPhase('idle')
    setCurrentRound(1)
    setRemaining(roundTotal)
  }, [roundTotal])

  // Keep remaining in sync with config while idle
  useEffect(() => {
    if (phase === 'idle') {
      setRemaining(roundTotal)
    }
  }, [roundTotal, phase])

  // Preset handlers
  const handleSavePreset = useCallback(() => {
    const name = (presetName ?? '').trim()
    if (!name) {
      toast.error('Please enter a preset name')
      return
    }
    const newPreset: Preset = {
      id: generateId(),
      name,
      rounds: totalRounds,
      roundSeconds: roundTotal,
      restSeconds: restTotal,
      createdAt: Date.now(),
    }
    const next = [...(presets ?? []), newPreset]
    setPresetsState(next)
    savePresets(next)
    setPresetName('')
    setActivePresetId(newPreset.id)
    toast.success(`Saved “${name}”`)
  }, [presetName, totalRounds, roundTotal, restTotal, presets])

  const handleLoadPreset = useCallback((p: Preset) => {
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
    setActivePresetId(p.id)
    // Reset runtime
    setRunning(false)
    setPhase('idle')
    setCurrentRound(1)
    toast.success(`Loaded “${p.name}”`)
  }, [])

  const handleDeletePreset = useCallback((id: string) => {
    const next = (presets ?? []).filter((p) => p?.id !== id)
    setPresetsState(next)
    savePresets(next)
    if (activePresetId === id) setActivePresetId(null)
    toast('Preset deleted')
  }, [presets, activePresetId])

  // Derived UI helpers
  const phaseLabel = useMemo(() => {
    if (phase === 'prep') return 'GET READY'
    if (phase === 'round') return `ROUND ${currentRound}`
    if (phase === 'rest') return 'REST'
    if (phase === 'finished') return 'FINISHED'
    return 'READY'
  }, [phase, currentRound])

  const phaseColorClass = useMemo(() => {
    if (phase === 'round') return 'text-red-500'
    if (phase === 'rest') return 'text-emerald-400'
    if (phase === 'finished') return 'text-amber-400'
    if (phase === 'prep') return 'text-sky-400'
    return 'text-muted-foreground'
  }, [phase])

  const ringColorClass = useMemo(() => {
    if (phase === 'round') return 'stroke-red-500'
    if (phase === 'rest') return 'stroke-emerald-400'
    if (phase === 'finished') return 'stroke-amber-400'
    if (phase === 'prep') return 'stroke-sky-400'
    return 'stroke-muted-foreground/50'
  }, [phase])

  const bgTintClass = useMemo(() => {
    if (phase === 'round') return 'from-red-500/10 via-transparent to-transparent'
    if (phase === 'rest') return 'from-emerald-400/10 via-transparent to-transparent'
    if (phase === 'prep') return 'from-sky-400/10 via-transparent to-transparent'
    if (phase === 'finished') return 'from-amber-400/10 via-transparent to-transparent'
    return 'from-transparent to-transparent'
  }, [phase])

  const isActive = running || phase === 'round' || phase === 'rest' || phase === 'prep'

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
            <div className="w-8 h-8 rounded-md bg-red-500/10 flex items-center justify-center">
              <Bell className="w-4 h-4 text-red-500" />
            </div>
            <span className="font-display font-semibold tracking-tight">Boxing Timer</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMuted((m) => !m)}
              aria-label={muted ? 'Unmute' : 'Mute'}
              className="gap-2"
            >
              {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              <span className="hidden sm:inline text-xs">{muted ? 'Muted' : 'Sound On'}</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] px-4 sm:px-6 py-8 sm:py-12">
        {/* Purpose statement */}
        <div className="text-center mb-8">
          <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight">
            Train by the <span className="text-red-500">bell</span>.
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
                    key={phase}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    transition={{ duration: 0.25 }}
                    className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold tracking-widest ${phaseColorClass} bg-foreground/5`}
                  >
                    {phase === 'round' && <Bell className="w-3.5 h-3.5" />}
                    {phase === 'rest' && <Coffee className="w-3.5 h-3.5" />}
                    {phase === 'finished' && <Trophy className="w-3.5 h-3.5" />}
                    {phase === 'prep' && <Dumbbell className="w-3.5 h-3.5" />}
                    {phase === 'idle' && <Dumbbell className="w-3.5 h-3.5" />}
                    <span>{phaseLabel}</span>
                  </motion.div>
                </AnimatePresence>
              </div>
              <div className="text-xs sm:text-sm text-muted-foreground font-mono">
                Round <span className="text-foreground font-semibold">{Math.min(currentRound, totalRounds)}</span> / {totalRounds}
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
                  <div className={`font-mono font-semibold tabular-nums tracking-tight ${phaseColorClass} text-6xl sm:text-7xl`}>
                    {formatSeconds(remaining)}
                  </div>
                  <div className="mt-2 text-xs uppercase tracking-[0.25em] text-muted-foreground">
                    {phase === 'idle' && 'Ready when you are'}
                    {phase === 'prep' && 'Starting soon'}
                    {phase === 'round' && 'Work'}
                    {phase === 'rest' && 'Recover'}
                    {phase === 'finished' && 'All rounds done'}
                  </div>
                </div>
              </div>
            </div>

            {/* Controls */}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              {!running ? (
                <Button
                  size="lg"
                  onClick={handleStart}
                  className="bg-red-500 hover:bg-red-600 text-white gap-2 px-6 shadow-md"
                >
                  <Play className="w-4 h-4" />
                  {phase === 'idle' || phase === 'finished' ? 'Start Workout' : 'Resume'}
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
                disabled={phase === 'idle'}
              >
                <Square className="w-4 h-4" />
                Stop
              </Button>
              <Button
                size="lg"
                variant="ghost"
                onClick={() => {
                  setRunning(false)
                  setPhase('idle')
                  setCurrentRound(1)
                  setRemaining(roundTotal)
                  toast('Timer reset')
                }}
                className="gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                Reset
              </Button>
            </div>
          </Card>

          {/* Sidebar: Settings + Presets */}
          <div className="flex flex-col gap-6">
            {/* Settings */}
            <Card className="p-5 bg-card/60 backdrop-blur shadow-md">
              <div className="flex items-center gap-2 mb-4">
                <Settings2 className="w-4 h-4 text-red-500" />
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
                  icon={<Bell className="w-3.5 h-3.5 text-red-500" />}
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
                  icon={<Coffee className="w-3.5 h-3.5 text-emerald-400" />}
                />

                <div className="pt-2 text-xs text-muted-foreground flex items-center justify-between">
                  <span>Total time</span>
                  <span className="font-mono">
                    {formatSeconds(totalRounds * roundTotal + Math.max(0, totalRounds - 1) * restTotal)}
                  </span>
                </div>
              </div>
            </Card>

            {/* Presets */}
            <Card className="p-5 bg-card/60 backdrop-blur shadow-md">
              <div className="flex items-center gap-2 mb-4">
                <ListChecks className="w-4 h-4 text-red-500" />
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
                              ? 'bg-red-500/10 ring-1 ring-red-500/30'
                              : 'bg-foreground/[0.03] hover:bg-foreground/[0.06]'
                          }`}
                        >
                          <button
                            onClick={() => handleLoadPreset(p)}
                            className="flex-1 text-left min-w-0"
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              {isActiveP && <Check className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />}
                              <span className="text-sm font-medium truncate">{p?.name ?? 'Untitled'}</span>
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
          <p>Tip: audio unlocks after you press Start. Keep the tab visible for best accuracy.</p>
        </footer>
      </main>
    </div>
  )
}

function NumberStepper({
  label,
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
  disabled?: boolean
}) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="mt-1.5 flex items-center gap-2">
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="h-9 w-9 flex-shrink-0"
          onClick={() => onChange((value ?? 0) - 1)}
          disabled={disabled || (value ?? 0) <= min}
          aria-label={`Decrease ${label}`}
        >
          <Minus className="w-3.5 h-3.5" />
        </Button>
        <Input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            const n = parseInt(e.target.value ?? '0', 10)
            onChange(Number.isFinite(n) ? n : min)
          }}
          disabled={disabled}
          className="h-9 text-center font-mono"
        />
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="h-9 w-9 flex-shrink-0"
          onClick={() => onChange((value ?? 0) + 1)}
          disabled={disabled || (value ?? 0) >= max}
          aria-label={`Increase ${label}`}
        >
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  )
}

function DurationField({
  label,
  minutes,
  seconds,
  onChange,
  disabled,
  icon,
}: {
  label: string
  minutes: number
  seconds: number
  onChange: (m: number, s: number) => void
  disabled?: boolean
  icon?: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        {icon}
        <Label className="text-xs text-muted-foreground">{label}</Label>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-2">
        <div>
          <Input
            type="number"
            min={0}
            max={59}
            value={minutes}
            onChange={(e) => {
              const n = parseInt(e.target.value ?? '0', 10)
              onChange(Number.isFinite(n) ? n : 0, seconds)
            }}
            disabled={disabled}
            className="h-9 text-center font-mono"
          />
          <p className="mt-1 text-[10px] text-center text-muted-foreground uppercase tracking-wider">min</p>
        </div>
        <div>
          <Input
            type="number"
            min={0}
            max={59}
            value={seconds}
            onChange={(e) => {
              const n = parseInt(e.target.value ?? '0', 10)
              onChange(minutes, Number.isFinite(n) ? n : 0)
            }}
            disabled={disabled}
            className="h-9 text-center font-mono"
          />
          <p className="mt-1 text-[10px] text-center text-muted-foreground uppercase tracking-wider">sec</p>
        </div>
      </div>
    </div>
  )
}
