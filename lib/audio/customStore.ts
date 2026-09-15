/**
 * The custom sound store: validated user uploads, persisted as IndexedDB blobs.
 *
 * An upload has to clear three gates before it is stored — `audio/*` MIME type, at most
 * 5 MB on disk, at most 10 seconds of *decoded* duration — and it must decode at all. A
 * rejection throws a {@link SoundUploadError} naming the gate that failed, and nothing is
 * written, so the caller's existing role assignments are untouched (requirements 3.4, 3.5).
 *
 * Persistence is behind {@link CustomSoundPersistence} for two reasons: jsdom has no
 * IndexedDB (so unit tests inject {@link createMemoryPersistence}), and a browser that
 * blocks IndexedDB — Safari private mode, for one — degrades to a session-only in-memory
 * store instead of failing the upload outright.
 *
 * Requirements: 3.4, 3.5
 */

import { getAudioContext } from '@/lib/audio'

/** Hard size cap for an upload, in bytes (requirement 3.4). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

/** Hard decoded-duration cap for an upload, in seconds (requirement 3.4). */
export const MAX_DURATION_SECONDS = 10

/** Which validation gate rejected an upload (requirement 3.5). */
export type UploadRejection = 'mime' | 'size' | 'duration' | 'decode'

/**
 * A rejected upload. `reason` identifies the failed validation and `message` is written to
 * be shown verbatim in the settings view.
 */
export class SoundUploadError extends Error {
  readonly reason: UploadRejection

  constructor(reason: UploadRejection, message: string) {
    super(message)
    this.name = 'SoundUploadError'
    this.reason = reason
  }
}

/** Everything known about a stored upload except its bytes. */
export interface CustomSoundMeta {
  blobId: string
  /** The original file name, used as the display label. */
  name: string
  mimeType: string
  sizeBytes: number
  /** Decoded duration in seconds, measured during validation. */
  durationSeconds: number
  createdAt: number
}

/** A stored upload including its bytes. */
export interface CustomSoundRecord extends CustomSoundMeta {
  blob: Blob
}

/** The persistence contract the store is written against. */
export interface CustomSoundPersistence {
  /** `true` when writes survive a reload. */
  readonly durable: boolean
  put(record: CustomSoundRecord): Promise<void>
  list(): Promise<CustomSoundMeta[]>
  get(blobId: string): Promise<CustomSoundRecord | null>
  remove(blobId: string): Promise<void>
}

/** The store surface used by the sound engine and the settings view. */
export interface CustomSoundStore {
  /** `true` when uploads survive a reload (IndexedDB present). */
  isDurable(): boolean
  /**
   * Validates and persists a file.
   *
   * @throws {SoundUploadError} when the MIME type, size, decodability or duration gate
   *   fails; nothing is written in that case (requirement 3.5).
   */
  add(file: File): Promise<CustomSoundMeta>
  /** Every stored upload, newest first (requirement 3.4 — selection enumeration). */
  list(): Promise<CustomSoundMeta[]>
  get(blobId: string): Promise<CustomSoundRecord | null>
  /** Deletes one upload. Deleting an absent id is a no-op. */
  remove(blobId: string): Promise<void>
}

/* -------------------------------------------------------------------------- */
/* Persistence implementations                                                 */
/* -------------------------------------------------------------------------- */

const DB_NAME = 'boxing_timer_sounds'
const DB_VERSION = 1
const STORE_NAME = 'custom_sounds'

const metaOf = (record: CustomSoundRecord): CustomSoundMeta => ({
  blobId: record.blobId,
  name: record.name,
  mimeType: record.mimeType,
  sizeBytes: record.sizeBytes,
  durationSeconds: record.durationSeconds,
  createdAt: record.createdAt,
})

const byNewestFirst = (a: CustomSoundMeta, b: CustomSoundMeta): number => b.createdAt - a.createdAt

/** A session-only store. Used in tests and where IndexedDB is unavailable. */
export function createMemoryPersistence(): CustomSoundPersistence {
  const records = new Map<string, CustomSoundRecord>()
  return {
    durable: false,
    async put(record) {
      records.set(record.blobId, record)
    },
    async list() {
      return [...records.values()].map(metaOf).sort(byNewestFirst)
    },
    async get(blobId) {
      return records.get(blobId) ?? null
    },
    async remove(blobId) {
      records.delete(blobId)
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

/** IndexedDB-backed persistence keyed by `blobId` (requirement 3.4). */
export function createIndexedDbPersistence(factory: IDBFactory): CustomSoundPersistence {
  let dbPromise: Promise<IDBDatabase> | null = null

  const open = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'blobId' })
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
    const result = await run(tx.objectStore(STORE_NAME))
    return result
  }

  return {
    durable: true,
    async put(record) {
      await withStore('readwrite', (store) => awaitRequest(store.put(record)))
    },
    async list() {
      const all = await withStore('readonly', (store) =>
        awaitRequest(store.getAll() as IDBRequest<CustomSoundRecord[]>)
      )
      return (all ?? []).map(metaOf).sort(byNewestFirst)
    },
    async get(blobId) {
      const record = await withStore('readonly', (store) =>
        awaitRequest(store.get(blobId) as IDBRequest<CustomSoundRecord | undefined>)
      )
      return record ?? null
    },
    async remove(blobId) {
      await withStore('readwrite', (store) => awaitRequest(store.delete(blobId)))
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

/** Measures decoded duration. Rejects (or resolves non-finite) when the file won't decode. */
export type DurationProbe = (bytes: ArrayBuffer, mimeType: string) => Promise<number>

export interface CustomSoundStoreOptions {
  persistence?: CustomSoundPersistence
  /** Duration measurement. Defaults to `decodeAudioData` on the shared AudioContext. */
  probeDuration?: DurationProbe
  generateBlobId?: () => string
  now?: () => number
}

/** Decodes with the shared AudioContext purely to read the duration. */
const defaultProbeDuration: DurationProbe = async (bytes) => {
  const ctx = getAudioContext()
  if (!ctx || typeof ctx.decodeAudioData !== 'function') {
    throw new SoundUploadError(
      'decode',
      'This browser cannot decode audio files, so the upload could not be checked.'
    )
  }
  // `decodeAudioData` detaches the buffer it is given, so hand it a copy.
  const buffer = await ctx.decodeAudioData(bytes.slice(0))
  return buffer.duration
}

function defaultBlobId(): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `snd-${Date.now().toString(36)}-${random}`
}

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/**
 * Reads a file's bytes. `File.arrayBuffer` is missing in a few old browsers and in some
 * test doubles, so `FileReader` is kept as a fallback.
 */
async function readBytes(file: File): Promise<ArrayBuffer> {
  if (typeof (file as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
    return file.arrayBuffer()
  }
  if (typeof FileReader === 'undefined') {
    throw new Error('No way to read the file')
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('File read failed'))
    reader.readAsArrayBuffer(file)
  })
}

/** Creates a store over the supplied (or default) persistence and duration probe. */
export function createCustomSoundStore(options: CustomSoundStoreOptions = {}): CustomSoundStore {
  const persistence = options.persistence ?? createMemoryPersistence()
  const probeDuration = options.probeDuration ?? defaultProbeDuration
  const generateBlobId = options.generateBlobId ?? defaultBlobId
  const now = options.now ?? Date.now

  return {
    isDurable: () => persistence.durable,

    async add(file: File): Promise<CustomSoundMeta> {
      if (!file) {
        throw new SoundUploadError('mime', 'No file was selected.')
      }

      // 1. MIME type (requirement 3.5).
      const mimeType = typeof file.type === 'string' ? file.type : ''
      if (!mimeType.startsWith('audio/')) {
        throw new SoundUploadError(
          'mime',
          `“${file.name || 'file'}” is ${mimeType ? `“${mimeType}”` : 'of an unknown type'}, not an audio file. Please choose an audio/* file.`
        )
      }

      // 2. Size (requirement 3.4).
      const sizeBytes = Number(file.size ?? 0)
      if (!Number.isFinite(sizeBytes) || sizeBytes > MAX_UPLOAD_BYTES) {
        throw new SoundUploadError(
          'size',
          `“${file.name || 'file'}” is ${megabytes(sizeBytes || 0)}. The limit is ${megabytes(MAX_UPLOAD_BYTES)}.`
        )
      }

      // 3. Decode (requirement 3.5).
      let bytes: ArrayBuffer
      let durationSeconds: number
      try {
        bytes = await readBytes(file)
        durationSeconds = await probeDuration(bytes, mimeType)
      } catch (error) {
        if (error instanceof SoundUploadError) throw error
        throw new SoundUploadError(
          'decode',
          `“${file.name || 'file'}” could not be decoded as audio. Try a different file or format.`
        )
      }
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new SoundUploadError(
          'decode',
          `“${file.name || 'file'}” could not be decoded as audio. Try a different file or format.`
        )
      }

      // 4. Duration (requirement 3.4).
      if (durationSeconds > MAX_DURATION_SECONDS) {
        throw new SoundUploadError(
          'duration',
          `“${file.name || 'file'}” is ${durationSeconds.toFixed(1)} s long. The limit is ${MAX_DURATION_SECONDS} s.`
        )
      }

      const record: CustomSoundRecord = {
        blobId: generateBlobId(),
        name: file.name || 'Custom sound',
        mimeType,
        sizeBytes,
        durationSeconds,
        createdAt: now(),
        // Persist the raw blob, not the decoded buffer: it is far smaller and re-decodes
        // cheaply once per session.
        blob: file,
      }

      await persistence.put(record)
      return metaOf(record)
    },

    list: () => persistence.list(),
    get: (blobId) => persistence.get(blobId),
    remove: (blobId) => persistence.remove(blobId),
  }
}

/** Resolves the best persistence available in this environment. */
function detectPersistence(): CustomSoundPersistence {
  if (typeof window === 'undefined') return createMemoryPersistence()
  try {
    const factory = window.indexedDB
    if (!factory) return createMemoryPersistence()
    return createIndexedDbPersistence(factory)
  } catch {
    return createMemoryPersistence()
  }
}

let sharedStore: CustomSoundStore | null = null

/**
 * The process-wide store. Created on first use so importing this module stays SSR-safe,
 * and backed by IndexedDB wherever it exists.
 */
export function getCustomSoundStore(): CustomSoundStore {
  if (!sharedStore) {
    sharedStore = createCustomSoundStore({ persistence: detectPersistence() })
  }
  return sharedStore
}

/** Test seam: drops the shared store so the next call re-detects persistence. */
export function resetCustomSoundStoreForTests(): void {
  sharedStore = null
}
