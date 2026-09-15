'use client'

/**
 * The custom workout builder.
 *
 * Pick a family (Boxing / MMA / Custom), optionally start from one of that family's default
 * workouts, adjust the round structure, and save. Validation runs through
 * `lib/data/workoutSchemas.ts`, so an out-of-bounds submission produces a message attached to
 * the offending input while every entered value stays exactly where the user left it — nothing
 * is persisted and nothing is silently rounded (requirements 5.6, 5.7).
 *
 * Every colour resolves from a semantic token (`bg-primary/10`, `text-primary`,
 * `text-destructive`, `ring-primary/30`), so the theme stays defined in `app/globals.css`
 * (requirement 10.10).
 *
 * The component is self-contained: it reads and writes the saved-workout list itself and
 * reports each save through `onSaved` so a host view can refresh alongside it. Task 12.1 gives
 * it a tab of its own.
 *
 * Requirements: 5.1, 5.2, 5.5, 5.6, 5.7, 10.10
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, Coffee, Dumbbell, Hammer, Save, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DurationField, NumberStepper } from '@/app/_components/workout-inputs'
import {
  WORKOUT_BOUNDS,
  validateWorkoutDraft,
  type WorkoutIssueField,
} from '@/lib/data/workoutSchemas'
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

/** The selector's options, in display order (requirement 5.1). */
const WORKOUT_TYPE_OPTIONS: ReadonlyArray<{ value: WorkoutType; icon: typeof Bell }> = [
  { value: 'BOXING', icon: Bell },
  { value: 'MMA', icon: Dumbbell },
  { value: 'CUSTOM', icon: Hammer },
]

/** The starting point a freshly selected type seeds the form with. */
const TYPE_DEFAULTS: Record<WorkoutType, { roundSeconds: number; restSeconds: number; prepSeconds: number; rounds: number }> = {
  BOXING: { rounds: 12, roundSeconds: 180, restSeconds: 60, prepSeconds: 5 },
  MMA: { rounds: 3, roundSeconds: 300, restSeconds: 60, prepSeconds: 10 },
  CUSTOM: { rounds: 5, roundSeconds: 120, restSeconds: 30, prepSeconds: DEFAULT_PREP_SECONDS },
}

export interface WorkoutBuilderProps {
  /** Called with the persisted workout after a successful save. */
  onSaved?: (workout: Preset) => void
}

export default function WorkoutBuilder({ onSaved }: WorkoutBuilderProps) {
  const [type, setType] = useState<WorkoutType>('BOXING')
  const [name, setName] = useState<string>('')
  const [rounds, setRounds] = useState<number>(TYPE_DEFAULTS.BOXING.rounds)
  const [roundMinutes, setRoundMinutes] = useState<number>(3)
  const [roundSecondsField, setRoundSecondsField] = useState<number>(0)
  const [restMinutes, setRestMinutes] = useState<number>(1)
  const [restSecondsField, setRestSecondsField] = useState<number>(0)
  const [prepSeconds, setPrepSeconds] = useState<number>(DEFAULT_PREP_SECONDS)

  /** The per-field validation messages from the last rejected submission. */
  const [errors, setErrors] = useState<Partial<Record<WorkoutIssueField, string>>>({})

  /** The saved list, seeded with the defaults exactly as the timer view seeds it. */
  const [workouts, setWorkouts] = useState<Preset[]>([])

  useEffect(() => {
    const saved = loadPresets()
    setWorkouts(saved.length > 0 ? saved : DEFAULT_PRESETS)
  }, [])

  const roundSeconds = useMemo(
    () => (roundMinutes ?? 0) * 60 + (roundSecondsField ?? 0),
    [roundMinutes, roundSecondsField]
  )
  const restSeconds = useMemo(
    () => (restMinutes ?? 0) * 60 + (restSecondsField ?? 0),
    [restMinutes, restSecondsField]
  )

  /** The default workouts offered as starting points for the selected type (req 5.5). */
  const startingPoints = useMemo(
    () => DEFAULT_PRESETS.filter((preset) => preset.type === type),
    [type]
  )

  const totalSeconds = useMemo(
    () =>
      Math.max(0, prepSeconds ?? 0) +
      Math.max(0, rounds ?? 0) * roundSeconds +
      Math.max(0, (rounds ?? 0) - 1) * restSeconds,
    [prepSeconds, rounds, roundSeconds, restSeconds]
  )

  const applyDurations = useCallback((source: { roundSeconds: number; restSeconds: number; prepSeconds?: number; rounds: number }) => {
    setRounds(source.rounds)
    setRoundMinutes(Math.floor(source.roundSeconds / 60))
    setRoundSecondsField(source.roundSeconds % 60)
    setRestMinutes(Math.floor(source.restSeconds / 60))
    setRestSecondsField(source.restSeconds % 60)
    setPrepSeconds(source.prepSeconds ?? DEFAULT_PREP_SECONDS)
  }, [])

  const handleSelectType = useCallback(
    (next: WorkoutType) => {
      if (next === type) return
      setType(next)
      applyDurations(TYPE_DEFAULTS[next])
      setErrors({})
    },
    [type, applyDurations]
  )

  /** Copies a default workout into the form so the user can adjust it (requirement 5.5). */
  const handleUseStartingPoint = useCallback(
    (preset: Preset) => {
      applyDurations(preset)
      setName(`${preset.name} (copy)`)
      setErrors({})
    },
    [applyDurations]
  )

  const handleSave = useCallback(() => {
    const result = validateWorkoutDraft({
      name,
      type,
      rounds,
      roundSeconds,
      restSeconds,
      prepSeconds,
    })

    if (!result.success) {
      // Requirement 5.7: surface the offending field, keep every entered value, persist nothing.
      setErrors(result.errors)
      toast.error(result.firstIssue.message)
      return
    }

    const workout: Preset = {
      id: generateId(),
      ...result.data,
      createdAt: Date.now(),
    }

    const next = [...workouts, workout]
    setWorkouts(next)
    savePresets(next)
    setErrors({})
    setName('')
    // Requirement 5.6: a success confirmation follows the persisted workout.
    toast.success(`Saved “${workout.name}”`)
    onSaved?.(workout)
  }, [name, type, rounds, roundSeconds, restSeconds, prepSeconds, workouts, onSaved])

  /** A validation message rendered beneath its own input. */
  const fieldError = (field: WorkoutIssueField) =>
    errors[field] ? (
      <p role="alert" className="mt-1 text-[11px] text-destructive">
        {errors[field]}
      </p>
    ) : null

  return (
    <Card className="p-5 sm:p-6 bg-card/60 backdrop-blur shadow-md">
      <div className="flex items-center gap-2 mb-1">
        <Hammer className="w-4 h-4 text-primary" />
        <h2 className="font-display font-semibold tracking-tight">Workout Builder</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Build a round structure for boxing, MMA, or anything else you train.
      </p>

      {/* Type selector (requirement 5.1) */}
      <div className="mt-5" role="radiogroup" aria-label="Workout type">
        <Label className="text-xs text-muted-foreground">Workout type</Label>
        <div className="mt-1.5 grid grid-cols-3 gap-2">
          {WORKOUT_TYPE_OPTIONS.map(({ value, icon: Icon }) => {
            const selected = type === value
            return (
              <Button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                variant={selected ? 'default' : 'outline'}
                onClick={() => handleSelectType(value)}
                className="h-11 gap-1.5 text-xs sm:text-sm"
              >
                <Icon className="w-3.5 h-3.5" />
                {workoutTypeLabel(value)}
              </Button>
            )
          })}
        </div>
        {fieldError('type')}
      </div>

      {/* Starting points for the selected type (requirement 5.5) */}
      <div className="mt-5">
        <div className="flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          <Label className="text-xs text-muted-foreground">
            {workoutTypeLabel(type)} starting points
          </Label>
        </div>
        {startingPoints.length === 0 ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            No presets for custom workouts — set the structure you want below.
          </p>
        ) : (
          <ul className="mt-1.5 space-y-2">
            {startingPoints.map((preset) => (
              <li key={preset.id}>
                <button
                  type="button"
                  onClick={() => handleUseStartingPoint(preset)}
                  className="w-full rounded-lg bg-foreground/[0.03] px-3 py-2.5 text-left transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium truncate">{preset.name}</span>
                    <Badge variant="secondary" className="ml-auto flex-shrink-0 text-[10px]">
                      {workoutTypeLabel(preset.type)}
                    </Badge>
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {preset.rounds} × {formatSeconds(preset.roundSeconds)}
                    <span className="mx-1.5 opacity-50">·</span>
                    rest {formatSeconds(preset.restSeconds)}
                    <span className="mx-1.5 opacity-50">·</span>
                    prep {preset.prepSeconds ?? DEFAULT_PREP_SECONDS}s
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The editable workout (requirement 5.2) */}
      <div className="mt-6 space-y-4">
        <div>
          <Label htmlFor="workout-name" className="text-xs text-muted-foreground">
            Name
          </Label>
          <Input
            id="workout-name"
            value={name}
            onChange={(e) => setName(e.target.value ?? '')}
            placeholder="e.g. Sparring prep 8×3"
            maxLength={WORKOUT_BOUNDS.name.max}
            aria-invalid={Boolean(errors.name)}
            className="mt-1.5 h-9"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
            }}
          />
          {fieldError('name')}
        </div>

        <NumberStepper
          label="Rounds"
          value={rounds}
          min={WORKOUT_BOUNDS.rounds.min}
          max={WORKOUT_BOUNDS.rounds.max}
          onChange={setRounds}
          hint={fieldError('rounds')}
        />

        <DurationField
          label="Round duration"
          minutes={roundMinutes}
          seconds={roundSecondsField}
          onChange={(m, s) => {
            setRoundMinutes(m)
            setRoundSecondsField(s)
          }}
          icon={<Bell className="w-3.5 h-3.5 text-primary" />}
          hint={fieldError('roundSeconds')}
        />

        <DurationField
          label="Rest duration"
          minutes={restMinutes}
          seconds={restSecondsField}
          onChange={(m, s) => {
            setRestMinutes(m)
            setRestSecondsField(s)
          }}
          icon={<Coffee className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />}
          hint={fieldError('restSeconds')}
        />

        <NumberStepper
          label="Prep countdown (sec)"
          value={prepSeconds}
          min={WORKOUT_BOUNDS.prepSeconds.min}
          max={WORKOUT_BOUNDS.prepSeconds.max}
          onChange={setPrepSeconds}
          hint={fieldError('prepSeconds')}
        />

        {fieldError('workout')}

        <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
          <span>Total time</span>
          <span className="font-mono">{formatSeconds(totalSeconds)}</span>
        </div>

        <Button onClick={handleSave} className="h-11 w-full gap-2">
          <Save className="w-4 h-4" />
          Save workout
        </Button>
      </div>
    </Card>
  )
}
