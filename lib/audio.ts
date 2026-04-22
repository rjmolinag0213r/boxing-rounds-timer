// Web Audio API based synthetic sound generator.
// No external audio files required.

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

// A bright, resonant bell (for round start). Metallic multi-partial ring.
export function playRoundStartBell(): void {
  const ctx = getCtx()
  if (!ctx) return
  try {
    const now = ctx.currentTime
    const master = ctx.createGain()
    master.gain.setValueAtTime(0.0001, now)
    master.gain.exponentialRampToValueAtTime(0.9, now + 0.01)
    master.gain.exponentialRampToValueAtTime(0.0001, now + 1.6)
    master.connect(ctx.destination)

    // Partials for a bright bell
    const partials = [880, 1320, 1760, 2640]
    const gains = [1.0, 0.55, 0.4, 0.2]
    partials.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, now)
      g.gain.setValueAtTime(0.0001, now)
      g.gain.exponentialRampToValueAtTime(gains[i] ?? 0.3, now + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.4)
      osc.connect(g)
      g.connect(master)
      osc.start(now)
      osc.stop(now + 1.6)
    })

    // Triple-ring pattern for round start
    for (let i = 1; i <= 2; i++) {
      const t = now + i * 0.22
      const g2 = ctx.createGain()
      g2.gain.setValueAtTime(0.0001, t)
      g2.gain.exponentialRampToValueAtTime(0.7, t + 0.01)
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 1.2)
      g2.connect(ctx.destination)
      partials.forEach((freq, idx) => {
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, t)
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime((gains[idx] ?? 0.3) * 0.8, t + 0.01)
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0)
        osc.connect(g)
        g.connect(g2)
        osc.start(t)
        osc.stop(t + 1.2)
      })
    }
  } catch {
    // ignore
  }
}

// A lower, softer buzzer tone (for rest start). Double-beep low tone.
export function playRestStartBuzzer(): void {
  const ctx = getCtx()
  if (!ctx) return
  try {
    const now = ctx.currentTime
    const beep = (start: number, duration: number) => {
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
      g.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + duration + 0.02)
    }
    beep(now, 0.35)
    beep(now + 0.5, 0.55)
  } catch {
    // ignore
  }
}

// Short warning tick (last 3 seconds)
export function playWarningTick(): void {
  const ctx = getCtx()
  if (!ctx) return
  try {
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(1200, now)
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(0.3, now + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.15)
    osc.connect(g)
    g.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.2)
  } catch {
    // ignore
  }
}
