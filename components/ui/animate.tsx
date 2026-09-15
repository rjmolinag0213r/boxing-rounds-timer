'use client'

/**
 * The shared framer-motion presets.
 *
 * framer-motion durations are JavaScript values, so the
 * `@media (prefers-reduced-motion: reduce)` block in `app/globals.css` cannot reach them.
 * Every helper here therefore reads {@link usePrefersReducedMotion} and passes its duration
 * through {@link motionDurationSeconds}, which caps it at 10 ms, and drops the travel offset
 * so the element fades in place instead of sliding (requirement 10.7).
 *
 * Requirements: 10.7
 */

import { motion } from 'framer-motion'

import { motionDurationSeconds, motionOffset, usePrefersReducedMotion } from '@/lib/ui/motion'

const viewportConfig = { once: true, margin: '-60px' as `${number}px` }

export function FadeIn({
  children, delay = 0, duration = 0.4, className,
}: {
  children: React.ReactNode; delay?: number; duration?: number; className?: string
}) {
  const reduced = usePrefersReducedMotion()
  return (
    <motion.div
      initial={{ opacity: 0, y: motionOffset(8, reduced) }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewportConfig}
      transition={{
        duration: motionDurationSeconds(duration, reduced),
        delay: reduced ? 0 : delay,
        ease: 'easeOut',
      }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function ScaleIn({
  children, delay = 0, className,
}: {
  children: React.ReactNode; delay?: number; className?: string
}) {
  const reduced = usePrefersReducedMotion()
  return (
    <motion.div
      initial={{ opacity: 0, scale: reduced ? 1 : 0.95 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={viewportConfig}
      transition={{
        duration: motionDurationSeconds(0.3, reduced),
        delay: reduced ? 0 : delay,
        ease: 'easeOut',
      }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

const slideDirections = {
  bottom: { y: 20, x: 0 },
  top:    { y: -20, x: 0 },
  left:   { x: -20, y: 0 },
  right:  { x: 20, y: 0 },
}

export function SlideIn({
  children, from = 'bottom', delay = 0, className,
}: {
  children: React.ReactNode; from?: keyof typeof slideDirections; delay?: number; className?: string
}) {
  const reduced = usePrefersReducedMotion()
  const direction = slideDirections[from]
  return (
    <motion.div
      initial={{
        opacity: 0,
        x: motionOffset(direction.x, reduced),
        y: motionOffset(direction.y, reduced),
      }}
      whileInView={{ opacity: 1, x: 0, y: 0 }}
      viewport={viewportConfig}
      transition={{
        duration: motionDurationSeconds(0.4, reduced),
        delay: reduced ? 0 : delay,
        ease: 'easeOut',
      }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function Stagger({
  children, staggerDelay = 0.08, className,
}: {
  children: React.ReactNode; staggerDelay?: number; className?: string
}) {
  const reduced = usePrefersReducedMotion()
  return (
    <motion.div
      variants={{
        show: { transition: { staggerChildren: reduced ? 0 : staggerDelay } },
      }}
      initial="hidden"
      whileInView="show"
      viewport={viewportConfig}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function StaggerItem({
  children, className,
}: {
  children: React.ReactNode; className?: string
}) {
  const reduced = usePrefersReducedMotion()
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: motionOffset(16, reduced) },
        show: {
          opacity: 1,
          y: 0,
          transition: { duration: motionDurationSeconds(0.4, reduced), ease: 'easeOut' },
        },
      }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function HoverLift({
  children, className,
}: {
  children: React.ReactNode; className?: string
}) {
  const reduced = usePrefersReducedMotion()
  return (
    <motion.div
      whileHover={reduced ? undefined : { y: -2, boxShadow: 'var(--shadow-lg)' }}
      transition={{ duration: motionDurationSeconds(0.15, reduced), ease: 'easeOut' }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function PressScale({
  children, className,
}: {
  children: React.ReactNode; className?: string
}) {
  const reduced = usePrefersReducedMotion()
  return (
    <motion.div
      whileTap={reduced ? undefined : { scale: 0.98 }}
      transition={{ duration: motionDurationSeconds(0.1, reduced), ease: 'easeOut' }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function SkeletonPulse({ className }: { className?: string }) {
  const reduced = usePrefersReducedMotion()
  return (
    <motion.div
      animate={reduced ? { opacity: 1 } : { opacity: [0.4, 1, 0.4] }}
      transition={
        reduced
          ? { duration: motionDurationSeconds(1.5, true) }
          : { duration: 1.5, repeat: Infinity, ease: 'easeInOut' }
      }
      className={`rounded-md bg-muted ${className ?? ''}`}
    />
  )
}
