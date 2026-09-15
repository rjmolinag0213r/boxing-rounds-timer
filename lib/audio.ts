/**
 * Web Audio synthesis: the timer's default sounds and its guaranteed fallback.
 *
 * No external audio files are required here — every tone is generated from oscillators, so
 * these functions work offline, on first paint, and when a bundled asset or a user upload
 * fails to load. `lib/audio/soundEngine.ts` layers selectable sources on top and always
 * falls back to {@link renderSynth} (requirements 3.1, 3.7).
 *
 * Each tone exists in two forms:
 *
 * - a `render*` function that writes into a **supplied** context, destination node and
 *   start time, so the sound engine can route it through its master gain and pre-schedule
 *   it against the AudioContext clock (requirement 4.2);
 * - a `play*` wrapper that renders into the shared context's destination immediately,
 *   which is the original API the timer view used.
 *
 * Requirements: 3.1, 3.7, 3.8, 4.2
 */

import type { SynthId } from './audio/types'

/**
 * The slice of `AudioContext` the synth renderers need.
 *
 * Declared structurally (and loosely) so a real `AudioContext`, an `OfflineAudioContext`
 * and a test double all satisfy it without casts at the call site.
 */
export interface SynthContext {
  readonly currentTime: number
  createOscillator(): any
  createGain(): any
}

let audioCtx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    if (!audioCtx) {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext
      if (!AC) return null
      audioCtx = new AC()
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume?.().catch(() => {})
    }
    return audioCtx
  } catch {
    return null
  }
}

/**
 * The process-wide `AudioContext`, created on first use and resumed when suspended.
 *
 * Returns `null` where Web Audio does not exist (server rendering, jsdom, very old
 * browsers), which is what keeps every caller a safe no-op instead of a crash.
 */
export function getAudioContext(): AudioContext | null {
  return getCtx()
}

export function unlockAudio(): void {
  const ctx = getCtx()
  if (!ctx) return
  // Play a tiny silent buffer to unlock on mobile browsers
  try {
    const buffer = ctx.createBuffer(1, 1, 22050)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start(0)
  } catch {
    // ignore
  }
}

/* -------------------------------------------------------------------------- */
/* Renderers — parameterized by context, destination and start time            */
/* -------------------------------------------------------------------------- */

/** A bright, resonant bell with a triple-ring pattern. The round-start default. */
export function renderBell(ctx: SynthContext, destination: any, when: number): void {
  const partials = [880, 1320, 1760, 2640]
  const gains = [1.0, 0.55, 0.4, 0.2]

  const ring = (start: number, level: number, tail: number): void => {
    const bus = ctx.createGain()
    bus.gain.setValueAtTime(0.0001, start)
    bus.gain.exponentialRampToValueAtTime(level, start + 0.01)
    bus.gain.exponentialRampToValueAtTime(0.0001, start + tail + 0.2)
    bus.connect(destination)

    partials.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, start)
      g.gain.setValueAtTime(0.0001, start)
      g.gain.exponentialRampToValueAtTime((gains[i] ?? 0.3) * (level >= 0.9 ? 1 : 0.8), start + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, start + tail)
      osc.connect(g)
      g.connect(bus)
      osc.start(start)
      osc.stop(start + tail + 0.2)
    })
  }

  ring(when, 0.9, 1.4)
  ring(when + 0.22, 0.7, 1.0)
  ring(when + 0.44, 0.7, 1.0)
}

/** A lower, softer double-beep buzzer. The rest-start default. */
export function renderBuzzer(ctx: SynthContext, destination: any, when: number): void {
  const beep = (start: number, duration: number): void => {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'square'
    osc.frequency.setValueAtTime(220, start)
    osc.frequency.linearRampToValueAtTime(180, start + duration)
    g.gain.setValueAtTime(0.0001, start)
    g.gain.exponentialRampToValueAtTime(0.35, start + 0.02)
    g.gain.setValueAtTime(0.35, start + duration - 0.05)
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    osc.connect(g)
    g.connect(destination)
    osc.start(start)
    osc.stop(start + duration + 0.02)
  }
  beep(when, 0.35)
  beep(when + 0.5, 0.55)
}

/** A short, high tick. The final-seconds warning default. */
export function renderTick(ctx: SynthContext, destination: any, when: number): void {
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(1200, when)
  g.gain.setValueAtTime(0.0001, when)
  g.gain.exponentialRampToValueAtTime(0.3, when + 0.005)
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.15)
  osc.connect(g)
  g.connect(destination)
  osc.start(when)
  osc.stop(when + 0.2)
}

/**
 * A blaring two-tone air horn. This is the **finished** role's synth tone: the workout is
 * over and it should be unmistakable, not another round bell (requirement 3.1).
 */
export function renderAirHorn(ctx: SynthContext, destination: any, when: number): void {
  const duration = 1.1
  const bus = ctx.createGain()
  bus.gain.setValueAtTime(0.0001, when)
  bus.gain.exponentialRampToValueAtTime(0.5, when + 0.06)
  bus.gain.setValueAtTime(0.5, when + duration - 0.25)
  bus.gain.exponentialRampToValueAtTime(0.0001, when + duration)
  bus.connect(destination)

  // Two slightly detuned saws an interval apart give the classic honking beat.
  for (const freq of [370, 466]) {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(freq, when)
    osc.frequency.linearRampToValueAtTime(freq * 0.97, when + duration)
    g.gain.setValueAtTime(0.45, when)
    osc.connect(g)
    g.connect(bus)
    osc.start(when)
    osc.stop(when + duration + 0.05)
  }
}

/** A plain mid-range beep, offered as an alternative for any role. */
export function renderBeep(ctx: SynthContext, destination: any, when: number): void {
  const duration = 0.24
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = 'square'
  osc.frequency.setValueAtTime(880, when)
  g.gain.setValueAtTime(0.0001, when)
  g.gain.exponentialRampToValueAtTime(0.28, when + 0.01)
  g.gain.setValueAtTime(0.28, when + duration - 0.04)
  g.gain.exponentialRampToValueAtTime(0.0001, when + duration)
  osc.connect(g)
  g.connect(destination)
  osc.start(when)
  osc.stop(when + duration + 0.02)
}

/**
 * Renders the tone named by `synthId` into `destination`, starting at `when` on `ctx`'s
 * clock. Swallows every Web Audio error: a failed decoration must never break a workout.
 */
export function renderSynth(
  synthId: SynthId,
  ctx: SynthContext,
  destination: any,
  when: number
): void {
  try {
    switch (synthId) {
      case 'bell':
        renderBell(ctx, destination, when)
        return
      case 'buzzer':
        renderBuzzer(ctx, destination, when)
        return
      case 'tick':
        renderTick(ctx, destination, when)
        return
      case 'airhorn':
        renderAirHorn(ctx, destination, when)
        return
      case 'beep':
        renderBeep(ctx, destination, when)
        return
      default:
        renderBell(ctx, destination, when)
    }
  } catch {
    // ignore
  }
}

/* -------------------------------------------------------------------------- */
/* Immediate playback wrappers (the original API)                              */
/* -------------------------------------------------------------------------- */

function playNow(synthId: SynthId): void {
  const ctx = getCtx()
  if (!ctx) return
  renderSynth(synthId, ctx, ctx.destination, ctx.currentTime)
}

/** The round-start bell (`synth:bell`). */
export function playRoundStartBell(): void {
  playNow('bell')
}

/** The rest-start buzzer (`synth:buzzer`). */
export function playRestStartBuzzer(): void {
  playNow('buzzer')
}

/** The final-seconds warning tick (`synth:tick`). */
export function playWarningTick(): void {
  playNow('tick')
}

/** The workout-finished air horn (`synth:airhorn`). */
export function playFinishedHorn(): void {
  playNow('airhorn')
}

/** The generic beep (`synth:beep`). */
export function playBeep(): void {
  playNow('beep')
}

/** Plays any synth tone immediately by id. */
export function playSynth(synthId: SynthId): void {
  playNow(synthId)
}
