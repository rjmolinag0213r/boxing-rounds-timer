'use client'

/**
 * The numeric inputs shared by the timer view and the workout builder.
 *
 * These were originally local to `boxing-timer.tsx`; they live here so the builder reuses
 * the exact same controls (and therefore the same touch targets, labels and token-driven
 * colours) instead of growing a second, drifting copy.
 *
 * Colours resolve entirely from semantic tokens — no hardcoded palette utilities — so the
 * light/dark blocks in `app/globals.css` stay the single source of truth (requirement 9.7).
 *
 * Requirements: 5.2, 10.10
 */

import type React from 'react'
import { Minus, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export interface NumberStepperProps {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  disabled?: boolean
  /** Rendered under the field, e.g. a validation message or a unit hint. */
  hint?: React.ReactNode
}

/** A bounded integer input flanked by decrement/increment buttons. */
export function NumberStepper({
  label,
  value,
  min,
  max,
  onChange,
  disabled,
  hint,
}: NumberStepperProps) {
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
          aria-label={label}
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
      {hint}
    </div>
  )
}

export interface DurationFieldProps {
  label: string
  minutes: number
  seconds: number
  onChange: (minutes: number, seconds: number) => void
  disabled?: boolean
  icon?: React.ReactNode
  /** Rendered under the field, e.g. a validation message. */
  hint?: React.ReactNode
}

/** A minutes + seconds pair, each bounded to 0–59. */
export function DurationField({
  label,
  minutes,
  seconds,
  onChange,
  disabled,
  icon,
  hint,
}: DurationFieldProps) {
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
            aria-label={`${label} minutes`}
            onChange={(e) => {
              const n = parseInt(e.target.value ?? '0', 10)
              onChange(Number.isFinite(n) ? n : 0, seconds)
            }}
            disabled={disabled}
            className="h-9 text-center font-mono"
          />
          <p className="mt-1 text-[10px] text-center text-muted-foreground uppercase tracking-wider">
            min
          </p>
        </div>
        <div>
          <Input
            type="number"
            min={0}
            max={59}
            value={seconds}
            aria-label={`${label} seconds`}
            onChange={(e) => {
              const n = parseInt(e.target.value ?? '0', 10)
              onChange(minutes, Number.isFinite(n) ? n : 0)
            }}
            disabled={disabled}
            className="h-9 text-center font-mono"
          />
          <p className="mt-1 text-[10px] text-center text-muted-foreground uppercase tracking-wider">
            sec
          </p>
        </div>
      </div>
      {hint}
    </div>
  )
}
