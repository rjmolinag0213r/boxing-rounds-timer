'use client'

/**
 * The workout history view.
 *
 * Reads the recorded sessions from the shared repository and renders them newest-first, with the
 * current calendar week's totals on top (requirements 7.1, 7.3). Each row shows only what the
 * session itself stored — its own `workoutName` and `type` snapshot — so a run stays fully
 * readable after its workout definition has been deleted; nothing here ever looks a workout up
 * (requirement 6.6).
 *
 * Because reads are served from browser storage first, a failed refresh is a *sync* failure, not
 * a data loss: the error banner appears with a retry control while the sessions already on this
 * device stay on screen (requirement 7.6). With no sessions at all, an empty state invites the
 * first workout instead (requirement 7.5). When the account has records that have not reached
 * the server, an unsynchronized indicator says so (requirement 8.10).
 *
 * Finished and stopped runs are distinguished twice over — by a labelled badge and by the row's
 * accent bar — so the difference does not rest on colour alone (requirements 7.7, 10.8). Every
 * colour resolves from a semantic token (requirement 10.10).
 *
 * Requirements: 6.6, 7.1, 7.2, 7.3, 7.5, 7.6, 7.7, 10.8, 10.10
 */

import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { format } from 'date-fns'
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  Dumbbell,
  History,
  Layers,
  RefreshCw,
  StopCircle,
  Timer,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { HoverLift, Stagger, StaggerItem } from '@/components/ui/animate'
import {
  computeWeeklyAggregates,
  formatDurationMs,
  sortSessionsNewestFirst,
  type WeekStartsOn,
  type WeeklyAggregates,
} from '@/lib/data/historyAggregates'
import { getWorkoutRepository } from '@/lib/data/repositoryClient'
import type { SyncState } from '@/lib/data/workoutRepository'
import { workoutTypeLabel } from '@/lib/presets'
import type { WorkoutSessionDTO } from '@/lib/types'

/**
 * The slice of the repository this view needs.
 *
 * Narrow on purpose: `listHistory` is required, the sync-state members are optional, so a test
 * (or a future local-only host) can pass a plain object.
 */
export interface HistorySource {
  listHistory(): Promise<WorkoutSessionDTO[]>
  getState?(): SyncState
  subscribe?(listener: (state: SyncState) => void): () => void
  retryPending?(): Promise<void>
}

export interface HistoryViewProps {
  /** Defaults to the shared client repository. */
  repository?: HistorySource
  /** Clock for the weekly window. Defaults to `Date.now`; fixed in tests. */
  now?: () => number
  /** First day of the aggregate week. Defaults to Monday. */
  weekStartsOn?: WeekStartsOn
}

export default function HistoryView({ repository, now, weekStartsOn }: HistoryViewProps) {
  const [sessions, setSessions] = useState<WorkoutSessionDTO[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  /** Set only when a load fails; the already-loaded sessions are deliberately kept. */
  const [error, setError] = useState<string | null>(null)
  const [sync, setSync] = useState<SyncState | null>(null)
  /** Fixed at mount so the week window does not shift between renders. */
  const [nowMs, setNowMs] = useState<number>(() => (now ? now() : Date.now()))

  /** Resolved once: the shared singleton must not be re-created on every render. */
  const sourceRef = useRef<HistorySource | null>(repository ?? null)
  const getSource = useCallback((): HistorySource => {
    if (!sourceRef.current) sourceRef.current = getWorkoutRepository()
    return sourceRef.current
  }, [])

  const load = useCallback(async () => {
    const source = getSource()
    setLoading(true)
    try {
      const records = await source.listHistory()
      setSessions(sortSessionsNewestFirst(records ?? []))
      setError(null)
    } catch (cause) {
      // Requirement 7.6: report the failure, keep whatever this device already had on screen.
      setError(cause instanceof Error ? cause.message : 'Could not load your workout history.')
    } finally {
      setNowMs(now ? now() : Date.now())
      setSync(source.getState?.() ?? null)
      setLoading(false)
    }
  }, [getSource, now])

  useEffect(() => {
    void load()
  }, [load])

  // Track sync state so the unsynchronized indicator follows a background push (req 8.10).
  useEffect(() => {
    const source = getSource()
    if (!source.subscribe) return
    return source.subscribe((next) => setSync(next))
  }, [getSource])

  /** The retry control: push anything pending, then re-read (requirements 7.6, 8.10). */
  const handleRetry = useCallback(async () => {
    const source = getSource()
    try {
      await source.retryPending?.()
    } catch {
      // A failed push must not stop the re-read; `load` reports whatever it finds.
    }
    await load()
  }, [getSource, load])

  const aggregates: WeeklyAggregates = useMemo(
    () => computeWeeklyAggregates(sessions, nowMs, { weekStartsOn }),
    [sessions, nowMs, weekStartsOn]
  )

  const unsynchronized = sync !== null && !sync.synchronized

  return (
    <Card className="p-5 sm:p-6 bg-card/60 backdrop-blur shadow-md">
      <div className="flex items-center gap-2 mb-1">
        <History className="w-4 h-4 text-primary" />
        <h2 className="font-display font-semibold tracking-tight">History</h2>
        {unsynchronized ? (
          <Badge
            variant="outline"
            className="ml-auto gap-1 border-primary/40 text-[10px] text-primary"
          >
            <CloudOff className="w-3 h-3" aria-hidden="true" />
            {sync?.pendingCount ?? 0} not synced
          </Badge>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Refresh workout history"
          onClick={() => void handleRetry()}
          disabled={loading}
          className={`h-8 w-8 ${unsynchronized ? '' : 'ml-auto'}`}
        >
          <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Every round you have logged, newest first.
      </p>

      {/* Weekly aggregates (requirement 7.3) */}
      <div className="mt-5 grid grid-cols-3 gap-2" aria-label="This week's totals" role="group">
        <AggregateCard
          icon={<Layers className="w-3.5 h-3.5 text-primary" aria-hidden="true" />}
          label="Sessions"
          value={String(aggregates.sessionCount)}
        />
        <AggregateCard
          icon={<Dumbbell className="w-3.5 h-3.5 text-primary" aria-hidden="true" />}
          label="Rounds"
          value={String(aggregates.completedRounds)}
        />
        <AggregateCard
          icon={<Timer className="w-3.5 h-3.5 text-primary" aria-hidden="true" />}
          label="Time"
          value={formatDurationMs(aggregates.totalDurationMs)}
        />
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Week of {format(new Date(aggregates.week.startMs), 'd MMM')} –{' '}
        {format(new Date(aggregates.week.endMs - 1), 'd MMM')}
      </p>

      {/* Error state with retry (requirement 7.6) */}
      {error ? (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5"
        >
          <AlertTriangle className="mt-0.5 w-3.5 h-3.5 flex-shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-destructive">Could not refresh your history</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {sessions.length > 0
                ? 'Showing the sessions saved on this device.'
                : 'No sessions are available on this device yet.'}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Retry loading workout history"
            onClick={() => void handleRetry()}
            disabled={loading}
            className="h-8 flex-shrink-0 gap-1.5 text-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : null}

      {/* The list, or the empty state (requirements 7.1, 7.5) */}
      {sessions.length === 0 ? (
        loading ? (
          <p className="mt-6 text-center text-xs text-muted-foreground">Loading your history…</p>
        ) : (
          <div className="mt-6 rounded-xl border border-dashed border-border bg-foreground/[0.02] px-4 py-8 text-center">
            <History className="mx-auto w-6 h-6 text-primary" aria-hidden="true" />
            <p className="mt-2 text-sm font-medium">No workouts yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Start the timer and finish your first round — it will show up here.
            </p>
          </div>
        )
      ) : (
        <Stagger className="mt-5">
          <ul aria-label="Workout history" className="space-y-2">
            {sessions.map((session) => (
              <li key={session.id}>
                <StaggerItem>
                  <SessionRow session={session} />
                </StaggerItem>
              </li>
            ))}
          </ul>
        </Stagger>
      )}
    </Card>
  )
}

/** One weekly total. */
function AggregateCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="rounded-lg bg-primary/10 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      </div>
      <p className="mt-0.5 font-mono text-base font-semibold tabular-nums">{value}</p>
    </div>
  )
}

/**
 * One history row (requirement 7.2).
 *
 * Reads `workoutName` and `type` straight off the session record, never from a workout lookup,
 * which is what keeps deleted-workout history intact (requirement 6.6). Completion is carried by
 * the badge's text *and* the accent bar, so it survives greyscale and colour-blindness
 * (requirement 7.7).
 */
function SessionRow({ session }: { session: WorkoutSessionDTO }) {
  const endedAt = new Date(session.endedAt)
  const finished = session.completed === true

  return (
    <HoverLift>
      <div
        className={`rounded-lg border-l-2 bg-foreground/[0.03] px-3 py-2.5 ${
          finished ? 'border-l-primary' : 'border-l-muted-foreground/40'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {/* Stored name — independent of the workout definition (requirement 6.6) */}
          <span className="text-sm font-medium truncate">{session.workoutName}</span>
          <Badge variant="secondary" className="ml-auto flex-shrink-0 text-[10px]">
            {workoutTypeLabel(session.type)}
          </Badge>
          {finished ? (
            <Badge variant="default" className="flex-shrink-0 gap-1 text-[10px]">
              <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
              Finished
            </Badge>
          ) : (
            <Badge variant="outline" className="flex-shrink-0 gap-1 text-[10px] text-muted-foreground">
              <StopCircle className="w-3 h-3" aria-hidden="true" />
              Stopped
            </Badge>
          )}
        </div>
        <div className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
          <time dateTime={endedAt.toISOString()}>{format(endedAt, 'EEE d MMM, HH:mm')}</time>
          <span className="mx-1.5 opacity-50">·</span>
          {session.roundsCompleted}/{session.roundsPlanned} rounds
          <span className="mx-1.5 opacity-50">·</span>
          {formatDurationMs(session.totalDurationMs)}
        </div>
      </div>
    </HoverLift>
  )
}
