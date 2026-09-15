/**
 * The hybrid workout/history repository — the fix for "I saved a workout on my phone and it
 * wasn't on my computer".
 *
 * Everything used to live in per-device browser storage, so a record simply could not travel.
 * The repository keeps that storage as the working copy (it is what makes the app usable with
 * no account, offline, and instantly) and adds the server as a mirror:
 *
 * - **Local_Only_Mode** — no session: reads and writes touch browser storage only
 *   (requirement 8.1).
 * - **Authenticated** — every write goes to browser storage *first*, then to the API
 *   (requirement 8.2), so a failed request never costs the user the record they just made.
 * - **First load on a new device** — an authenticated user whose browser storage is empty is
 *   hydrated from the server, which is precisely the phone→computer case (requirement 8.3).
 * - **Sign-in** — local records the server does not have are pushed and marked synchronized
 *   (requirement 8.4).
 * - **Server down** — an unreachable API or a 503 is not an error the user sees: the app keeps
 *   serving browser storage, `SyncState.synchronized` goes false so the UI can show an
 *   unsynchronized indicator, failed writes are marked pending, and they are retried on the
 *   next successful request (requirements 6.7, 8.10).
 * - **Sign-out** — back to Local_Only_Mode (requirement 8.11).
 *
 * Conflicts are resolved by a deliberately boring rule: for a record present on both sides,
 * the server wins **unless** the local copy is pending (i.e. it was written while the server
 * was unreachable), in which case the local copy is pushed and wins.
 *
 * Requirements: 6.5, 6.7, 8.1, 8.2, 8.3, 8.4, 8.5, 8.10, 8.11, 12.10
 */

import {
  DEFAULT_PREP_SECONDS,
  loadPresets,
  savePresets,
  type Preset,
  type WorkoutType,
} from '@/lib/presets'
import type { WorkoutDTO, WorkoutSessionDTO } from '@/lib/types'

import {
  createDefaultSessionPersistence,
  type SessionPersistence,
} from './sessionStore'

/* -------------------------------------------------------------------------- */
/* The contract                                                                */
/* -------------------------------------------------------------------------- */

/** The single surface the builder, the timer view, and the history view read and write. */
export interface WorkoutRepository {
  listWorkouts(): Promise<Preset[]>
  saveWorkout(workout: Preset): Promise<void>
  deleteWorkout(id: string): Promise<void>
  /** Newest end timestamp first (requirement 7.1). */
  listHistory(): Promise<WorkoutSessionDTO[]>
  recordSession(session: WorkoutSessionDTO): Promise<void>
}

/* -------------------------------------------------------------------------- */
/* Remote failure taxonomy                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The server could not be reached, or answered 503 (no `DATABASE_URL`, database down) or
 * another 5xx. **Retryable**: the record stays local and pending (requirements 8.9, 8.10).
 */
export class RemoteUnavailableError extends Error {
  readonly status?: number

  constructor(message: string, status?: number, cause?: unknown) {
    super(message)
    this.name = 'RemoteUnavailableError'
    this.status = status
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

/** The server answered 401: this device is not signed in (requirement 8.7). */
export class RemoteUnauthorizedError extends Error {
  constructor(message = 'Not signed in') {
    super(message)
    this.name = 'RemoteUnauthorizedError'
  }
}

/**
 * The server answered 400 and named the invalid fields (requirement 8.8). **Not** retryable:
 * re-sending an identical body would fail identically, so it is reported to the caller
 * (requirement 6.5).
 */
export class RemoteValidationError extends Error {
  readonly fields: Record<string, string>

  constructor(message: string, fields: Record<string, string> = {}) {
    super(message)
    this.name = 'RemoteValidationError'
    this.fields = fields
  }
}

/** Any other non-OK response (404, 409, …). Not retryable. */
export class RemoteRequestError extends Error {
  readonly status: number

  constructor(status: number, message = `Request failed with status ${status}`) {
    super(message)
    this.name = 'RemoteRequestError'
    this.status = status
  }
}

/* -------------------------------------------------------------------------- */
/* Preset <-> DTO                                                              */
/* -------------------------------------------------------------------------- */

/** The stored workout as the API sees it. `prepSeconds` is defaulted, never omitted. */
export function presetToWorkoutDTO(preset: Preset): WorkoutDTO {
  return {
    id: preset.id,
    name: preset.name,
    type: preset.type ?? 'BOXING',
    rounds: preset.rounds,
    roundSeconds: preset.roundSeconds,
    restSeconds: preset.restSeconds,
    prepSeconds: preset.prepSeconds ?? DEFAULT_PREP_SECONDS,
    createdAt: preset.createdAt,
  }
}

export function workoutDTOToPreset(dto: WorkoutDTO): Preset {
  return {
    id: dto.id,
    name: dto.name,
    type: (dto.type ?? 'BOXING') as WorkoutType,
    rounds: dto.rounds,
    roundSeconds: dto.roundSeconds,
    restSeconds: dto.restSeconds,
    prepSeconds: dto.prepSeconds ?? DEFAULT_PREP_SECONDS,
    createdAt: dto.createdAt,
  }
}

/* -------------------------------------------------------------------------- */
/* Local repository                                                            */
/* -------------------------------------------------------------------------- */

export interface LocalWorkoutRepositoryOptions {
  /** History persistence. Defaults to IndexedDB with an in-memory fallback. */
  persistence?: SessionPersistence
  /** Workout list reader. Defaults to `loadPresets()` (localStorage, v1→v2 migrated). */
  readWorkouts?: () => Preset[]
  /** Workout list writer. Defaults to `savePresets()`. */
  writeWorkouts?: (workouts: Preset[]) => void
}

/**
 * Browser-storage-only implementation: localStorage for workouts, IndexedDB for history.
 *
 * This is the whole repository in Local_Only_Mode, and the working copy in authenticated mode.
 */
export class LocalWorkoutRepository implements WorkoutRepository {
  private readonly persistence: SessionPersistence
  private readonly readWorkouts: () => Preset[]
  private readonly writeWorkouts: (workouts: Preset[]) => void

  constructor(options: LocalWorkoutRepositoryOptions = {}) {
    this.persistence = options.persistence ?? createDefaultSessionPersistence()
    this.readWorkouts = options.readWorkouts ?? loadPresets
    this.writeWorkouts = options.writeWorkouts ?? savePresets
  }

  async listWorkouts(): Promise<Preset[]> {
    return this.readWorkouts()
  }

  async saveWorkout(workout: Preset): Promise<void> {
    const existing = this.readWorkouts()
    const next = existing.some((w) => w.id === workout.id)
      ? existing.map((w) => (w.id === workout.id ? workout : w))
      : [...existing, workout]
    this.writeWorkouts(next)
  }

  async deleteWorkout(id: string): Promise<void> {
    this.writeWorkouts(this.readWorkouts().filter((w) => w.id !== id))
  }

  /** Replaces the whole workout list — used when hydrating or merging with the server. */
  async replaceWorkouts(workouts: Preset[]): Promise<void> {
    this.writeWorkouts(workouts)
  }

  async listHistory(): Promise<WorkoutSessionDTO[]> {
    return this.persistence.list()
  }

  async recordSession(session: WorkoutSessionDTO): Promise<void> {
    await this.persistence.put(session)
  }

  /** Replaces the whole history — used when hydrating or merging with the server. */
  async replaceSessions(sessions: WorkoutSessionDTO[]): Promise<void> {
    await this.persistence.replaceAll(sessions)
  }

  /** `true` when history survives a reload (IndexedDB available). */
  isDurable(): boolean {
    return this.persistence.durable
  }
}

/* -------------------------------------------------------------------------- */
/* Remote repository                                                           */
/* -------------------------------------------------------------------------- */

export interface RemoteWorkoutRepositoryOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Prefixed to every path. Empty in the browser. */
  baseUrl?: string
}

/** Talks to `/api/workouts` and `/api/sessions`, translating HTTP into the error taxonomy. */
export class RemoteWorkoutRepository {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string

  constructor(options: RemoteWorkoutRepositoryOptions = {}) {
    const injected = options.fetchImpl
    this.fetchImpl =
      injected ??
      ((input, init) => {
        if (typeof fetch !== 'function') {
          return Promise.reject(new RemoteUnavailableError('No fetch implementation available'))
        }
        return fetch(input, init)
      })
    this.baseUrl = options.baseUrl ?? ''
  }

  async listWorkouts(): Promise<WorkoutDTO[]> {
    const body = await this.request('/api/workouts', { method: 'GET' })
    return Array.isArray(body?.workouts) ? (body.workouts as WorkoutDTO[]) : []
  }

  async saveWorkout(workout: WorkoutDTO): Promise<void> {
    await this.request('/api/workouts', { method: 'POST', body: JSON.stringify(workout) })
  }

  /** A 404 means the row is already gone, which is the outcome the caller asked for. */
  async deleteWorkout(id: string): Promise<void> {
    try {
      await this.request(`/api/workouts/${encodeURIComponent(id)}`, { method: 'DELETE' })
    } catch (error) {
      if (error instanceof RemoteRequestError && error.status === 404) return
      throw error
    }
  }

  async listHistory(): Promise<WorkoutSessionDTO[]> {
    const body = await this.request('/api/sessions', { method: 'GET' })
    return Array.isArray(body?.sessions) ? (body.sessions as WorkoutSessionDTO[]) : []
  }

  async recordSession(session: WorkoutSessionDTO): Promise<void> {
    await this.request('/api/sessions', { method: 'POST', body: JSON.stringify(session) })
  }

  private async request(path: string, init: RequestInit): Promise<any> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      })
    } catch (error) {
      // A network failure, an offline device, a service worker rejection: all retryable.
      throw new RemoteUnavailableError(`Could not reach ${path}`, undefined, error)
    }

    if (response.status === 401) throw new RemoteUnauthorizedError()
    // 503 is the documented "no database" answer (requirement 8.9); any other 5xx is just as
    // retryable, so both are the same signal to the sync logic (requirement 8.10).
    if (response.status === 503 || response.status >= 500) {
      throw new RemoteUnavailableError(`Server unavailable (${response.status})`, response.status)
    }
    if (response.status === 400) {
      const body = await this.safeJson(response)
      throw new RemoteValidationError(
        typeof body?.error === 'string' ? body.error : 'Validation failed',
        (body?.fields as Record<string, string>) ?? {}
      )
    }
    if (!response.ok) throw new RemoteRequestError(response.status)

    return this.safeJson(response)
  }

  private async safeJson(response: Response): Promise<any> {
    try {
      return await response.json()
    } catch {
      return undefined
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Pending-record registry                                                     */
/* -------------------------------------------------------------------------- */

/** Ids whose server write has not succeeded yet. */
export interface PendingRecords {
  workouts: string[]
  sessions: string[]
  /** Workouts deleted locally whose deletion has not reached the server. */
  deletions: string[]
}

export interface PendingStore {
  read(): PendingRecords
  write(records: PendingRecords): void
}

export const PENDING_STORAGE_KEY = 'boxing_timer_pending_sync_v1'

const emptyPending = (): PendingRecords => ({ workouts: [], sessions: [], deletions: [] })

const asIdList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []

/** localStorage-backed, so pending work survives a reload. Degrades to a no-op silently. */
export function createLocalStoragePendingStore(): PendingStore {
  return {
    read() {
      if (typeof window === 'undefined') return emptyPending()
      try {
        const raw = window.localStorage.getItem(PENDING_STORAGE_KEY)
        if (!raw) return emptyPending()
        const parsed = JSON.parse(raw)
        return {
          workouts: asIdList(parsed?.workouts),
          sessions: asIdList(parsed?.sessions),
          deletions: asIdList(parsed?.deletions),
        }
      } catch {
        return emptyPending()
      }
    },
    write(records) {
      if (typeof window === 'undefined') return
      try {
        window.localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(records))
      } catch {
        // Full or unavailable storage: pending state degrades to in-memory only.
      }
    },
  }
}

/** In-memory registry, for tests and for browsers without usable localStorage. */
export function createMemoryPendingStore(initial: Partial<PendingRecords> = {}): PendingStore {
  let records: PendingRecords = { ...emptyPending(), ...initial }
  return {
    read: () => ({
      workouts: [...records.workouts],
      sessions: [...records.sessions],
      deletions: [...records.deletions],
    }),
    write: (next) => {
      records = {
        workouts: [...next.workouts],
        sessions: [...next.sessions],
        deletions: [...next.deletions],
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Syncing repository                                                          */
/* -------------------------------------------------------------------------- */

/** What the UI needs to show an unsynchronized-data indicator (requirement 8.10). */
export interface SyncState {
  mode: 'local-only' | 'authenticated'
  userId: string | null
  /** `false` => some local record has not reached the server yet. */
  synchronized: boolean
  pendingCount: number
  /** The most recent sync failure, for a tooltip or a retry affordance. */
  lastError: string | null
}

export interface SyncingRepositoryOptions {
  local: LocalWorkoutRepository
  remote: Pick<
    RemoteWorkoutRepository,
    'listWorkouts' | 'saveWorkout' | 'deleteWorkout' | 'listHistory' | 'recordSession'
  >
  /** Pending-id registry. Defaults to localStorage-backed. */
  pending?: PendingStore
}

type PendingKind = keyof PendingRecords

const mergeById = <T extends { id: string }>(
  remote: T[],
  local: T[],
  localWins: ReadonlySet<string>
): T[] => {
  const byId = new Map<string, T>()
  for (const record of remote) byId.set(record.id, record)
  for (const record of local) {
    if (!byId.has(record.id) || localWins.has(record.id)) byId.set(record.id, record)
  }
  return [...byId.values()]
}

/**
 * Wraps the local and remote repositories into the one the app uses.
 *
 * Reads always come from browser storage — hydrated and merged by {@link setSession} — which
 * keeps every render instant and keeps the app fully functional when the API is down. The
 * server is written to, and read from, only around session transitions and mirrored writes.
 */
export class SyncingRepository implements WorkoutRepository {
  private readonly local: LocalWorkoutRepository
  private readonly remote: SyncingRepositoryOptions['remote']
  private readonly pendingStore: PendingStore
  private readonly listeners = new Set<(state: SyncState) => void>()

  private userId: string | null = null
  private lastError: string | null = null
  /** Serializes reconcile/retry so two triggers cannot interleave their writes. */
  private inFlight: Promise<void> = Promise.resolve()
  private retrying = false

  constructor(options: SyncingRepositoryOptions) {
    this.local = options.local
    this.remote = options.remote
    this.pendingStore = options.pending ?? createLocalStoragePendingStore()
  }

  /* ----------------------------- observable state ----------------------------- */

  getState(): SyncState {
    const pending = this.pendingStore.read()
    const pendingCount =
      pending.workouts.length + pending.sessions.length + pending.deletions.length
    return {
      mode: this.userId ? 'authenticated' : 'local-only',
      userId: this.userId,
      // Local_Only_Mode has nothing to synchronize, so it is never "unsynchronized".
      synchronized: this.userId === null ? true : pendingCount === 0,
      pendingCount,
      lastError: this.lastError,
    }
  }

  /** Subscribes to sync-state changes. Returns the unsubscribe function. */
  subscribe(listener: (state: SyncState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }

  /* ------------------------------ session changes ----------------------------- */

  /**
   * Points the repository at a user, or at `null` for Local_Only_Mode.
   *
   * Signing in reconciles: local records the server does not have are pushed (requirement
   * 8.4) and server records this device has never seen are pulled — which for empty browser
   * storage is the whole account, the phone→computer fix (requirement 8.3). Signing out drops
   * straight back to browser storage (requirement 8.11).
   */
  async setSession(userId: string | null): Promise<void> {
    if (userId === null) {
      this.userId = null
      this.lastError = null
      // Pending marks describe work owed *for an account*; in Local_Only_Mode there is no
      // account to owe it to. A later sign-in re-pushes anything the server lacks anyway.
      this.pendingStore.write(emptyPending())
      this.notify()
      return
    }

    this.userId = userId
    this.notify()
    await this.enqueue(() => this.reconcile(userId))
  }

  /** Convenience alias for the sign-in path. */
  async signIn(userId: string): Promise<void> {
    await this.setSession(userId)
  }

  /** Convenience alias for the sign-out path (requirement 8.11). */
  async signOut(): Promise<void> {
    await this.setSession(null)
  }

  /* --------------------------------- reads ----------------------------------- */

  async listWorkouts(): Promise<Preset[]> {
    return this.local.listWorkouts()
  }

  async listHistory(): Promise<WorkoutSessionDTO[]> {
    return this.local.listHistory()
  }

  /* --------------------------------- writes ---------------------------------- */

  async saveWorkout(workout: Preset): Promise<void> {
    // Local first, always: the record is safe before the network is involved (8.2).
    await this.local.saveWorkout(workout)
    if (this.userId === null) return
    await this.mirror('workouts', workout.id, () =>
      this.remote.saveWorkout(presetToWorkoutDTO(workout))
    )
  }

  async deleteWorkout(id: string): Promise<void> {
    await this.local.deleteWorkout(id)
    this.clearPending('workouts', id)
    if (this.userId === null) return
    // Tracked as a pending *deletion* on failure, so a later reconcile does not pull the
    // deleted workout back from the server.
    await this.mirror('deletions', id, () => this.remote.deleteWorkout(id))
  }

  async recordSession(session: WorkoutSessionDTO): Promise<void> {
    await this.local.recordSession(session)
    if (this.userId === null) return
    await this.mirror('sessions', session.id, () => this.remote.recordSession(session))
  }

  /**
   * Sends one record, then flushes anything still pending.
   *
   * An unreachable server marks the record pending and returns quietly: the write already
   * succeeded locally, so from the user's point of view nothing failed — only the sync
   * indicator changes (requirements 6.7, 8.10). A *validation* rejection is different: it will
   * never succeed, so it is reported to the caller (requirements 6.5, 8.8).
   */
  private async mirror(kind: PendingKind, id: string, send: () => Promise<void>): Promise<void> {
    try {
      await send()
      this.clearPending(kind, id)
      this.lastError = null
      this.notify()
      // Requirement 8.10: a successful request is the trigger to retry the backlog.
      await this.retryPending()
    } catch (error) {
      if (error instanceof RemoteUnauthorizedError) {
        // The server says this device is not signed in; believe it and stop mirroring.
        await this.setSession(null)
        return
      }
      if (error instanceof RemoteUnavailableError) {
        this.markPending(kind, id, error.message)
        return
      }
      this.lastError = error instanceof Error ? error.message : String(error)
      this.notify()
      throw error
    }
  }

  /* -------------------------------- syncing ---------------------------------- */

  /**
   * Reconciles browser storage with the server for `userId`.
   *
   * One fetch of each collection answers both questions at once: which local records the
   * server is missing (push them — requirement 8.4, and the empty-local case is requirement
   * 8.3's hydration) and which server records this device is missing (merge them in).
   */
  private async reconcile(userId: string): Promise<void> {
    const localWorkouts = await this.local.listWorkouts()
    const localSessions = await this.local.listHistory()
    const pending = this.pendingStore.read()

    let remoteWorkouts: WorkoutDTO[]
    let remoteSessions: WorkoutSessionDTO[]
    try {
      remoteWorkouts = await this.remote.listWorkouts()
      remoteSessions = await this.remote.listHistory()
    } catch (error) {
      if (error instanceof RemoteUnauthorizedError) {
        await this.setSession(null)
        return
      }
      // Requirement 8.10: keep serving browser storage, flag it, and owe every local record
      // to the server so the next successful request pushes them.
      this.pendingStore.write({
        workouts: localWorkouts.map((w) => w.id),
        sessions: localSessions.map((s) => s.id),
        deletions: pending.deletions,
      })
      this.lastError = error instanceof Error ? error.message : String(error)
      this.notify()
      return
    }

    // Deletions this device made offline must be replayed before the merge, or the merge
    // would resurrect them from the server's copy.
    const replayedDeletions: string[] = []
    const failedDeletions: string[] = []
    for (const id of pending.deletions) {
      try {
        await this.remote.deleteWorkout(id)
        replayedDeletions.push(id)
      } catch (error) {
        if (error instanceof RemoteUnavailableError) failedDeletions.push(id)
        else replayedDeletions.push(id) // Unretryable: stop owing it.
      }
    }
    const deleted = new Set(replayedDeletions)
    const survivingRemoteWorkouts = remoteWorkouts.filter((w) => !deleted.has(w.id))

    const remoteWorkoutIds = new Set(survivingRemoteWorkouts.map((w) => w.id))
    const remoteSessionIds = new Set(remoteSessions.map((s) => s.id))
    const pendingWorkoutIds = new Set(pending.workouts)
    const pendingSessionIds = new Set(pending.sessions)

    const workoutsToPush = localWorkouts.filter(
      (w) => !remoteWorkoutIds.has(w.id) || pendingWorkoutIds.has(w.id)
    )
    const sessionsToPush = localSessions.filter(
      (s) => !remoteSessionIds.has(s.id) || pendingSessionIds.has(s.id)
    )

    const pushedWorkoutIds = new Set<string>()
    const stillPendingWorkouts: string[] = []
    for (const workout of workoutsToPush) {
      try {
        await this.remote.saveWorkout(presetToWorkoutDTO(workout))
        pushedWorkoutIds.add(workout.id)
      } catch (error) {
        if (error instanceof RemoteUnavailableError) stillPendingWorkouts.push(workout.id)
        else this.lastError = error instanceof Error ? error.message : String(error)
      }
    }

    const stillPendingSessions: string[] = []
    for (const session of sessionsToPush) {
      try {
        await this.remote.recordSession(session)
      } catch (error) {
        if (error instanceof RemoteUnavailableError) stillPendingSessions.push(session.id)
        else this.lastError = error instanceof Error ? error.message : String(error)
      }
    }

    // Merge both directions. The server wins for shared ids, except where the local copy was
    // written while the server was unreachable (it was just pushed, so it is the newer one).
    const mergedWorkouts = mergeById(
      survivingRemoteWorkouts.map(workoutDTOToPreset),
      localWorkouts,
      new Set([...pushedWorkoutIds, ...stillPendingWorkouts])
    )
    const mergedSessions = mergeById(remoteSessions, localSessions, new Set()).sort(
      (a, b) => b.endedAt - a.endedAt
    )

    await this.local.replaceWorkouts(mergedWorkouts)
    await this.local.replaceSessions(mergedSessions)

    this.pendingStore.write({
      workouts: stillPendingWorkouts,
      sessions: stillPendingSessions,
      deletions: failedDeletions,
    })
    if (
      stillPendingWorkouts.length === 0 &&
      stillPendingSessions.length === 0 &&
      failedDeletions.length === 0
    ) {
      this.lastError = null
    }
    // Guard against a sign-out that happened while this was in flight.
    if (this.userId === userId) this.notify()
  }

  /**
   * Pushes every pending record. Called after each successful request (requirement 8.10) and
   * available to a manual retry control.
   */
  async retryPending(): Promise<void> {
    if (this.userId === null || this.retrying) return

    const pending = this.pendingStore.read()
    if (pending.workouts.length + pending.sessions.length + pending.deletions.length === 0) return

    this.retrying = true
    try {
      const workouts = await this.local.listWorkouts()
      const sessions = await this.local.listHistory()
      const workoutById = new Map(workouts.map((w) => [w.id, w]))
      const sessionById = new Map(sessions.map((s) => [s.id, s]))

      const stillPendingWorkouts: string[] = []
      for (const id of pending.workouts) {
        const workout = workoutById.get(id)
        // Gone locally (deleted since): nothing left to owe.
        if (!workout) continue
        try {
          await this.remote.saveWorkout(presetToWorkoutDTO(workout))
        } catch (error) {
          if (error instanceof RemoteUnavailableError) stillPendingWorkouts.push(id)
          else this.lastError = error instanceof Error ? error.message : String(error)
        }
      }

      const stillPendingSessions: string[] = []
      for (const id of pending.sessions) {
        const session = sessionById.get(id)
        if (!session) continue
        try {
          await this.remote.recordSession(session)
        } catch (error) {
          if (error instanceof RemoteUnavailableError) stillPendingSessions.push(id)
          else this.lastError = error instanceof Error ? error.message : String(error)
        }
      }

      const stillPendingDeletions: string[] = []
      for (const id of pending.deletions) {
        try {
          await this.remote.deleteWorkout(id)
        } catch (error) {
          if (error instanceof RemoteUnavailableError) stillPendingDeletions.push(id)
        }
      }

      this.pendingStore.write({
        workouts: stillPendingWorkouts,
        sessions: stillPendingSessions,
        deletions: stillPendingDeletions,
      })
      if (
        stillPendingWorkouts.length === 0 &&
        stillPendingSessions.length === 0 &&
        stillPendingDeletions.length === 0
      ) {
        this.lastError = null
      }
      this.notify()
    } finally {
      this.retrying = false
    }
  }

  /* ------------------------------ pending marks ------------------------------ */

  private markPending(kind: PendingKind, id: string, message: string): void {
    const pending = this.pendingStore.read()
    if (!pending[kind].includes(id)) pending[kind] = [...pending[kind], id]
    this.pendingStore.write(pending)
    this.lastError = message
    this.notify()
  }

  private clearPending(kind: PendingKind, id: string): void {
    const pending = this.pendingStore.read()
    if (!pending[kind].includes(id)) return
    pending[kind] = pending[kind].filter((pendingId) => pendingId !== id)
    this.pendingStore.write(pending)
  }

  /** Serializes the reconcile/retry paths. */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.inFlight = this.inFlight.then(operation, operation)
    return this.inFlight
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Builds the repository the app uses: browser storage in front, the API behind it.
 *
 * Starts in Local_Only_Mode; call {@link SyncingRepository.setSession} once the optional
 * account is known (requirement 12.10 — no account and no database is a supported state, not
 * a degraded one).
 */
export function createWorkoutRepository(
  options: {
    persistence?: SessionPersistence
    fetchImpl?: typeof fetch
    pending?: PendingStore
  } = {}
): SyncingRepository {
  return new SyncingRepository({
    local: new LocalWorkoutRepository({ persistence: options.persistence }),
    remote: new RemoteWorkoutRepository({ fetchImpl: options.fetchImpl }),
    pending: options.pending,
  })
}
