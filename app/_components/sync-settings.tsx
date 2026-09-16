'use client'

/**
 * The Sync surface: pair a device, see what is paired, and start over.
 *
 * Five sections in the order a user needs them — status, generate a code, enter a code, paired
 * devices, rotate the sync space (requirement 12.4). Everything the status section shows comes
 * from the `SyncState` the repository publishes through `subscribe()`, so this panel and the
 * rest of the app can never disagree about whether a device is synced (requirement 11.5).
 *
 * **The countdown never talks to the server.** The `201` response carries `expiresAt`, so the
 * remaining time is arithmetic on a value already held (requirement 12.8). It is rendered in a
 * `role="timer"` region with `aria-live="off"`, and the *only* polite announcement in the whole
 * panel fires once, at expiry (requirements 12.6, 12.7). A naive `aria-live="polite"` on a
 * ticking second counter would produce roughly 600 announcements per code and make the panel
 * unusable with a screen reader.
 *
 * **A claim failure says exactly what the server said and nothing more.** Absent, expired,
 * consumed and malformed all answer with one uniform message by design; inventing a more
 * specific reason here would hand an attacker the oracle the server refuses to be
 * (requirements 5.8, 12.10).
 *
 * **Pairing merges, and merging is not reversible from this panel**, so the copy names that
 * before the user commits (requirement 9.9).
 *
 * Every colour resolves through a semantic token — there is no literal palette class anywhere
 * in this file (requirement 12.15) — every interactive element is at least 44 pixels tall
 * (12.14), focus rings come from `--ring` (12.16), and transitions carry
 * `motion-reduce:transition-none` on top of the `lib/ui/motion.ts` gate (12.17).
 *
 * Requirements: 5.8, 9.9, 11.5, 11.6, 12.4–12.17, 12.19, 12.20, 13.5
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Loader2, RefreshCw, RotateCcw, Unlink } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from '@/components/ui/input-otp'
import {
  PairingInvalidCodeError,
  PairingLimitError,
  PairingRateLimitedError,
  PairingUnavailableError,
  claimPairingCode,
  createPairingCode,
  listPairedDevices,
  rotateSyncSpace,
  unlinkDevice,
  type PairedDeviceInfo,
} from '@/lib/data/pairingClient'
import {
  getSyncAvailability,
  getWorkoutRepository,
  refreshIdentity,
  subscribeSyncAvailability,
} from '@/lib/data/repositoryClient'
import type { SyncingRepository, SyncState } from '@/lib/data/workoutRepository'
import { usePrefersReducedMotion } from '@/lib/ui/motion'
import { cn } from '@/lib/utils'

/* -------------------------------------------------------------------------- */
/* Copy and constants                                                          */
/* -------------------------------------------------------------------------- */

/** The one sentence shown on a deployment that cannot sync (requirement 12.19). */
const UNAVAILABLE_COPY =
  "Sync isn't set up on this server, so your workouts and history stay on this device. " +
  'Everything else keeps working.'

/** Named before the user commits, because the merge cannot be undone from here (9.9). */
const MERGE_NOTICE =
  "Pairing merges this device's workouts and history into the shared space. Both devices end " +
  'up with everything.'

const EXPIRY_ANNOUNCEMENT = 'Pairing code expired. Generate a new one.'

/** How the 8 slots are grouped, matching the `XXXX-XXXX` the other device is showing. */
const FIRST_GROUP = [0, 1, 2, 3]
const SECOND_GROUP = [4, 5, 6, 7]

/**
 * The keystrokes the code field accepts, in both cases.
 *
 * `InputOTP` defaults to digits only, which would silently swallow every letter of a code. The
 * set is spelled out literally rather than imported from `lib/pairing/code.ts`, because that
 * module imports `node:crypto` and must not be pulled into the browser bundle. It is a *typing
 * convenience only*: the server normalizes and is the sole authority on what a code means
 * (requirement 12.20). The excluded glyphs — `0`, `1`, `O`, `I`, `L` — are absent here for the
 * same reason they are absent from the alphabet: they are the pairs a user misreads.
 */
const CODE_PATTERN = '^[23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]*$'

/** The shared button geometry: thumb-sized, and focused through `--ring`. */
const CONTROL_CLASS =
  'min-h-[44px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'motion-reduce:transition-none'

/** `m:ss`, floored, never negative. */
function mmss(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** `lastSeenAt` as prose. A bad timestamp degrades to "recently" rather than to "Invalid Date". */
function relativeTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return 'recently'
  try {
    return `${formatDistanceToNow(new Date(epochMs))} ago`
  } catch {
    return 'recently'
  }
}

/** Turns any thrown pairing failure into the one line the user should read. */
function messageFor(error: unknown): string {
  if (error instanceof PairingRateLimitedError) {
    return `Too many tries. Wait ${error.retryAfterSeconds} seconds and try again.`
  }
  // The server's single uniform rejection, repeated verbatim and not elaborated on.
  if (error instanceof PairingInvalidCodeError) return error.message
  if (error instanceof PairingLimitError) return error.message
  if (error instanceof PairingUnavailableError) {
    return error.reason === 'offline'
      ? 'Pairing needs a connection. Everything else keeps working.'
      : 'Sync is unavailable right now. Your data stays on this device.'
  }
  return 'That did not work. Try again.'
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export interface SyncSettingsProps {
  className?: string
}

interface LiveCode {
  code: string
  expiresAt: number
}

export default function SyncSettings({ className }: SyncSettingsProps) {
  const repositoryRef = useRef<SyncingRepository | null>(null)
  const [syncState, setSyncState] = useState<SyncState | null>(null)
  const [available, setAvailable] = useState<boolean | null>(() => getSyncAvailability())

  const [liveCode, setLiveCode] = useState<LiveCode | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  const [entered, setEntered] = useState('')
  const [claiming, setClaiming] = useState(false)
  const [claimError, setClaimError] = useState<string | null>(null)
  const [claimed, setClaimed] = useState(false)

  const [devices, setDevices] = useState<PairedDeviceInfo[] | null>(null)
  const [devicesError, setDevicesError] = useState<string | null>(null)
  const [pendingUnlink, setPendingUnlink] = useState<PairedDeviceInfo | null>(null)
  const [rotateOpen, setRotateOpen] = useState(false)
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null)
  const [rotating, setRotating] = useState(false)

  const reducedMotion = usePrefersReducedMotion()

  /* ------------------------------ sync state ------------------------------ */

  useEffect(() => {
    if (!repositoryRef.current) repositoryRef.current = getWorkoutRepository()
    const repository = repositoryRef.current
    setSyncState(repository.getState())
    return repository.subscribe(setSyncState)
  }, [])

  useEffect(() => {
    setAvailable(getSyncAvailability())
    return subscribeSyncAvailability(setAvailable)
  }, [])

  /* ------------------------------- countdown ------------------------------ */

  const remainingMs = liveCode ? Math.max(0, liveCode.expiresAt - now) : 0
  const expired = liveCode !== null && remainingMs <= 0

  useEffect(() => {
    if (!liveCode) return
    // One local interval, no request: `expiresAt` is already known (requirement 12.8). It is
    // torn down the moment the code dies, so an expired panel is not still ticking.
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [liveCode])

  /* -------------------------------- devices ------------------------------- */

  const paired = syncState?.mode === 'authenticated'

  const loadDevices = useCallback(async (): Promise<void> => {
    try {
      const result = await listPairedDevices()
      setDevices(result.devices)
      setDevicesError(null)
    } catch (error) {
      // A device list that cannot be read is not worth an alarm: pairing still works, and the
      // status section above already says whether this device is synced.
      setDevices(null)
      setDevicesError(messageFor(error))
    }
  }, [])

  useEffect(() => {
    if (available !== true || !paired) {
      setDevices(null)
      return
    }
    void loadDevices()
  }, [available, paired, loadDevices])

  /* ------------------------------- handlers ------------------------------- */

  const handleGenerate = useCallback(async (): Promise<void> => {
    setGenerating(true)
    setGenerateError(null)
    try {
      const result = await createPairingCode()
      setLiveCode({ code: result.code, expiresAt: result.expiresAt })
      setNow(Date.now())
      // An anonymous caller was just given a space and a cookie, so the identity changed and
      // this device's library needs to upload (requirements 8.6, 11.9).
      await refreshIdentity()
      await loadDevices()
    } catch (error) {
      setLiveCode(null)
      setGenerateError(messageFor(error))
    } finally {
      setGenerating(false)
    }
  }, [loadDevices])

  const handleClaim = useCallback(
    async (value: string): Promise<void> => {
      setClaiming(true)
      setClaimError(null)
      try {
        await claimPairingCode(value)
        setClaimed(true)
        setEntered('')
        // The identity is new, so re-probe: the existing reconcile then merges both ways.
        await refreshIdentity()
        await loadDevices()
      } catch (error) {
        setClaimed(false)
        setClaimError(messageFor(error))
      } finally {
        setClaiming(false)
      }
    },
    [loadDevices]
  )

  const runUnlink = useCallback(
    async (device: PairedDeviceInfo): Promise<void> => {
      setBusyDeviceId(device.id)
      try {
        await unlinkDevice(device.id)
        await refreshIdentity()
        await loadDevices()
      } catch (error) {
        setDevicesError(messageFor(error))
      } finally {
        setBusyDeviceId(null)
        setPendingUnlink(null)
      }
    },
    [loadDevices]
  )

  const handleUnlinkClick = useCallback(
    (device: PairedDeviceInfo): void => {
      // Only the *current* device needs a confirmation: it is the one the user is holding, and
      // unlinking it stops sync under their feet (requirement 12.12).
      if (device.isCurrent) {
        setPendingUnlink(device)
        return
      }
      void runUnlink(device)
    },
    [runUnlink]
  )

  const handleRotate = useCallback(async (): Promise<void> => {
    setRotating(true)
    try {
      await rotateSyncSpace()
      setLiveCode(null)
      await refreshIdentity()
      await loadDevices()
    } catch (error) {
      setDevicesError(messageFor(error))
    } finally {
      setRotating(false)
      setRotateOpen(false)
    }
  }, [loadDevices])

  const handleRetryPending = useCallback((): void => {
    void repositoryRef.current?.retryPending()
  }, [])

  /* -------------------------------- status -------------------------------- */

  const statusLine = useMemo((): string => {
    if (!syncState || syncState.mode === 'local-only') {
      return 'Not synced. This device keeps its own workouts and history.'
    }
    if (!syncState.synchronized) {
      const count = syncState.pendingCount
      return `${count} ${count === 1 ? 'change' : 'changes'} waiting to sync.`
    }
    const deviceCount = devices?.length ?? 0
    return deviceCount > 0
      ? `Synced · ${deviceCount} ${deviceCount === 1 ? 'device' : 'devices'}`
      : 'Synced.'
  }, [syncState, devices])

  /* ------------------------- the unavailable branch ----------------------- */

  // One muted explanation in place of every pairing control (requirement 12.19). Rendering the
  // controls disabled instead would invite the user to try something that cannot work.
  if (available === false) {
    return (
      <div className={cn('space-y-4', className)}>
        <p
          className="text-sm text-muted-foreground"
          data-testid="sync-unavailable"
        >
          {UNAVAILABLE_COPY}
        </p>
      </div>
    )
  }

  return (
    <div className={cn('space-y-6', className)}>
      {/* 1 ─ Status ------------------------------------------------------- */}
      <section aria-labelledby="sync-status-heading" className="space-y-2">
        <h3 id="sync-status-heading" className="text-sm font-semibold">
          Status
        </h3>

        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={paired && syncState?.synchronized ? 'default' : 'outline'}
            className={cn(
              paired && syncState?.synchronized && 'border-transparent bg-primary/10 text-primary'
            )}
          >
            {statusLine}
          </Badge>

          {syncState && syncState.pendingCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              className={CONTROL_CLASS}
              onClick={handleRetryPending}
            >
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Retry now
            </Button>
          )}
        </div>

        {syncState?.source === 'oauth' && (
          <p className="text-xs text-muted-foreground">
            You&apos;re signed in, so your account&apos;s workouts are shown. Pairing extends that
            account rather than replacing it.
          </p>
        )}
      </section>

      {/* 2 ─ Generate a code --------------------------------------------- */}
      <section aria-labelledby="sync-generate-heading" className="space-y-2">
        <h3 id="sync-generate-heading" className="text-sm font-semibold">
          Link another device
        </h3>

        {liveCode && !expired ? (
          <div className="rounded-lg border border-border bg-muted/40 p-4 text-center">
            <p className="text-xs text-muted-foreground">Enter this code on your other device</p>
            <p className="mt-2 font-mono text-3xl font-semibold tracking-[0.2em] tabular-nums">
              {liveCode.code}
            </p>
            <p
              className="mt-2 text-xs text-muted-foreground tabular-nums"
              role="timer"
              // Per-second updates must not be announced; the sr-only region below fires once.
              aria-live="off"
              data-testid="sync-code-countdown"
            >
              Expires in {mmss(remainingMs)}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {expired && (
              <p className="text-xs text-muted-foreground" data-testid="sync-code-expired">
                That code expired.
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              className={CONTROL_CLASS}
              onClick={() => void handleGenerate()}
              disabled={generating}
            >
              {generating && (
                <Loader2
                  className={cn('mr-2 h-4 w-4 animate-spin', reducedMotion && 'animate-none')}
                  aria-hidden="true"
                />
              )}
              {expired ? 'Generate a new code' : 'Generate a code'}
            </Button>
          </div>
        )}

        {generateError && (
          <p role="alert" className="text-xs text-destructive">
            {generateError}
          </p>
        )}
      </section>

      {/*
        The panel's one and only polite live region. It is deliberately outside the section
        above so that replacing the code with the generate control cannot unmount it mid-
        announcement — and it holds text only at expiry, so it speaks exactly once (12.7).
      */}
      <p className="sr-only" aria-live="polite" data-testid="sync-code-announcement">
        {expired ? EXPIRY_ANNOUNCEMENT : ''}
      </p>

      {/* 3 ─ Enter a code ------------------------------------------------ */}
      <section aria-labelledby="sync-enter-heading" className="space-y-3">
        <h3 id="sync-enter-heading" className="text-sm font-semibold">
          Enter a code
        </h3>

        <p className="text-xs text-muted-foreground">{MERGE_NOTICE}</p>

        <InputOTP
          maxLength={8}
          value={entered}
          // Upper-cased for display only; the server normalizes independently and is the only
          // authority on what a code means (requirement 12.20).
          onChange={(value) => setEntered(value.toUpperCase())}
          onComplete={(value) => void handleClaim(value)}
          pattern={CODE_PATTERN}
          inputMode="text"
          disabled={claiming}
          aria-label="Pairing code from your other device"
          containerClassName="justify-center"
        >
          <InputOTPGroup>
            {FIRST_GROUP.map((index) => (
              <InputOTPSlot
                key={index}
                index={index}
                className={cn('h-11 w-11 min-h-[44px]', reducedMotion && '[&_div]:animate-none')}
              />
            ))}
          </InputOTPGroup>
          <InputOTPSeparator />
          <InputOTPGroup>
            {SECOND_GROUP.map((index) => (
              <InputOTPSlot
                key={index}
                index={index}
                className={cn('h-11 w-11 min-h-[44px]', reducedMotion && '[&_div]:animate-none')}
              />
            ))}
          </InputOTPGroup>
        </InputOTP>

        {/* The uniform server message, repeated and never elaborated on (5.8, 12.10). */}
        <div role="alert" data-testid="sync-claim-status" className="text-xs text-destructive">
          {claimError ?? ''}
        </div>

        {claimed && !claimError && (
          <p className="text-xs text-primary">Paired. Your workouts and history are merging now.</p>
        )}
      </section>

      {/* 4 ─ Paired devices ---------------------------------------------- */}
      <section aria-labelledby="sync-devices-heading" className="space-y-2">
        <h3 id="sync-devices-heading" className="text-sm font-semibold">
          Paired devices
        </h3>

        {!paired && (
          <p className="text-xs text-muted-foreground">
            No devices yet. Generate a code, or enter one from another device.
          </p>
        )}

        {paired && devices !== null && devices.length === 0 && (
          <p className="text-xs text-muted-foreground">No devices are paired yet.</p>
        )}

        {devices !== null && devices.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {devices.map((device) => (
              <li
                key={device.id}
                className="flex min-h-[44px] items-center justify-between gap-3 px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm">{device.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {device.isCurrent ? 'This device · ' : ''}
                    {relativeTime(device.lastSeenAt)}
                  </span>
                </span>

                <Button
                  variant="ghost"
                  size="sm"
                  className={CONTROL_CLASS}
                  // Unique per row: "Unlink" four times over tells a screen-reader user nothing.
                  aria-label={`Unlink ${device.label}`}
                  disabled={busyDeviceId === device.id}
                  onClick={() => handleUnlinkClick(device)}
                >
                  <Unlink className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only sm:ml-2 sm:text-xs">Unlink</span>
                </Button>
              </li>
            ))}
          </ul>
        )}

        {devicesError && (
          <p role="alert" className="text-xs text-destructive">
            {devicesError}
          </p>
        )}
      </section>

      {/* 5 ─ Rotate ------------------------------------------------------ */}
      <section aria-labelledby="sync-rotate-heading" className="space-y-2">
        <h3 id="sync-rotate-heading" className="text-sm font-semibold">
          Rotate sync space
        </h3>
        <p className="text-xs text-muted-foreground">
          Showed a code to the wrong person? Rotating gives you a brand new sync space.
        </p>
        <Button
          variant="destructive"
          size="sm"
          className={CONTROL_CLASS}
          onClick={() => setRotateOpen(true)}
          disabled={!paired || rotating}
        >
          <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
          Rotate sync space
        </Button>
      </section>

      {/* Confirmations --------------------------------------------------- */}

      <AlertDialog
        open={pendingUnlink !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUnlink(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink this device?</AlertDialogTitle>
            <AlertDialogDescription>
              This device stops syncing and keeps its own copy of your workouts and history. You
              can pair it again with a new code.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={CONTROL_CLASS}>Keep it paired</AlertDialogCancel>
            <AlertDialogAction
              className={CONTROL_CLASS}
              onClick={() => {
                if (pendingUnlink) void runUnlink(pendingUnlink)
              }}
            >
              Unlink this device
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate sync space?</AlertDialogTitle>
            <AlertDialogDescription>
              This unlinks every device, including this one, and any code you have shown stops
              working. Your workouts and history move with you to the new sync space. Other
              devices stop syncing and keep their own copy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={CONTROL_CLASS}>Cancel</AlertDialogCancel>
            <AlertDialogAction className={CONTROL_CLASS} onClick={() => void handleRotate()}>
              Rotate sync space
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
