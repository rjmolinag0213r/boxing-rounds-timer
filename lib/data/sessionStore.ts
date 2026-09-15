/**
 * Browser-side persistence for recorded sessions.
 *
 * Workouts live in localStorage (see `lib/presets.ts`) because they are few, small, and read
 * synchronously at startup. History is different: it grows without bound, so it goes in
 * IndexedDB, which has no ~5 MB quota and stores structured records without a JSON round-trip.
 *
 * Persistence sits behind {@link SessionPersistence} for the same two reasons as the custom
 * sound store: jsdom has no IndexedDB (tests inject {@link createMemorySessionPersistence}),
 * and a browser that blocks IndexedDB — Safari private mode — degrades to a session-only
 * in-memory store instead of losing the ability to record a workout at all.
 *
 * Requirements: 6.1, 6.7, 8.1
 */

import type { WorkoutSessionDTO } from '@/lib/types'

const DB_NAME = 'boxing_timer_history'
const DB_VERSION = 1
const STORE_NAME = 'sessions'

/** The persistence contract the repository is written against. */
export interface SessionPersistence {
  /** `true` when writes survive a reload. */
  readonly durable: boolean
  /** Every stored session, newest end timestamp first (requirement 7.1). */
  list(): Promise<WorkoutSessionDTO[]>
  /** Insert or replace one session, keyed by `id` — repeated writes stay idempotent. */
  put(session: WorkoutSessionDTO): Promise<void>
  /** Replace the entire store, used when hydrating from the server (requirement 8.3). */
  replaceAll(sessions: WorkoutSessionDTO[]): Promise<void>
  remove(id: string): Promise<void>
}

const byNewestFirst = (a: WorkoutSessionDTO, b: WorkoutSessionDTO): number => b.endedAt - a.endedAt

/** A session-only store. Used in tests and where IndexedDB is unavailable. */
export function createMemorySessionPersistence(
  initial: WorkoutSessionDTO[] = []
): SessionPersistence {
  const records = new Map<string, WorkoutSessionDTO>(initial.map((s) => [s.id, s]))
  return {
    durable: false,
    async list() {
      return [...records.values()].sort(byNewestFirst)
    },
    async put(session) {
      records.set(session.id, session)
    },
    async replaceAll(sessions) {
      records.clear()
      for (const session of sessions) records.set(session.id, session)
    },
    async remove(id) {
      records.delete(id)
    },
  }
}

/** Promisifies an IDBRequest. */
function awaitRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

/** IndexedDB-backed history, keyed by the client-generated session id. */
export function createIndexedDbSessionPersistence(factory: IDBFactory): SessionPersistence {
  let dbPromise: Promise<IDBDatabase> | null = null

  const open = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
      request.onblocked = () => reject(new Error('IndexedDB open blocked'))
    }).catch((error) => {
      // Let a later call retry rather than caching the failure forever.
      dbPromise = null
      throw error
    })
    return dbPromise
  }

  const withStore = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>
  ): Promise<T> => {
    const db = await open()
    const tx = db.transaction(STORE_NAME, mode)
    return run(tx.objectStore(STORE_NAME))
  }

  return {
    durable: true,
    async list() {
      const all = await withStore('readonly', (store) =>
        awaitRequest(store.getAll() as IDBRequest<WorkoutSessionDTO[]>)
      )
      return (all ?? []).sort(byNewestFirst)
    },
    async put(session) {
      await withStore('readwrite', (store) => awaitRequest(store.put(session)))
    },
    async replaceAll(sessions) {
      await withStore('readwrite', async (store) => {
        await awaitRequest(store.clear())
        for (const session of sessions) {
          await awaitRequest(store.put(session))
        }
      })
    },
    async remove(id) {
      await withStore('readwrite', (store) => awaitRequest(store.delete(id)))
    },
  }
}

/**
 * The best persistence this browser can offer: IndexedDB when it is usable, otherwise an
 * in-memory store that at least keeps the current tab's history readable.
 */
export function createDefaultSessionPersistence(): SessionPersistence {
  if (typeof indexedDB === 'undefined') return createMemorySessionPersistence()

  const idb = createIndexedDbSessionPersistence(indexedDB)
  const fallback = createMemorySessionPersistence()
  let broken = false

  /** Falls back permanently the first time IndexedDB throws (private mode, quota, …). */
  const via = async <T>(
    attempt: () => Promise<T>,
    recover: () => Promise<T>
  ): Promise<T> => {
    if (broken) return recover()
    try {
      return await attempt()
    } catch {
      broken = true
      return recover()
    }
  }

  return {
    get durable() {
      return !broken
    },
    list: () => via(() => idb.list(), () => fallback.list()),
    put: (session) => via(() => idb.put(session), () => fallback.put(session)),
    replaceAll: (sessions) => via(() => idb.replaceAll(sessions), () => fallback.replaceAll(sessions)),
    remove: (id) => via(() => idb.remove(id), () => fallback.remove(id)),
  }
}
