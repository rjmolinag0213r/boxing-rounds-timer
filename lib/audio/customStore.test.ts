/**
 * Unit tests for upload validation and the custom sound store (task 8.7).
 *
 * The three gates an upload must clear — `audio/*` MIME, ≤ 5 MB, ≤ 10 s decoded — are
 * checked one at a time, together with the "won't decode at all" path. Each rejection has
 * to name the validation that failed *and* leave the store untouched, because the settings
 * view reports the reason and the sound engine keeps its existing assignments on the
 * strength of that guarantee.
 *
 * Persistence is the in-memory implementation: jsdom has no IndexedDB, and the store is
 * written against an injectable interface precisely so these rules can be tested without
 * one.
 *
 * **Validates: Requirements 3.4, 3.5**
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createCustomSoundStore,
  createMemoryPersistence,
  MAX_DURATION_SECONDS,
  MAX_UPLOAD_BYTES,
  SoundUploadError,
  type CustomSoundPersistence,
  type CustomSoundStore,
  type DurationProbe,
} from './customStore'

/** A `File` stand-in: jsdom's `File` cannot cheaply claim a 6 MB size. */
function fakeFile(options: { name?: string; type?: string; size?: number }): File {
  const bytes = new ArrayBuffer(8)
  return {
    name: options.name ?? 'bell.mp3',
    type: options.type ?? 'audio/mpeg',
    size: options.size ?? 1024,
    arrayBuffer: async () => bytes,
  } as unknown as File
}

const probeReturning = (seconds: number): DurationProbe => vi.fn(async () => seconds)

describe('custom sound upload validation', () => {
  let persistence: CustomSoundPersistence
  let store: CustomSoundStore

  const build = (probeDuration: DurationProbe): CustomSoundStore =>
    createCustomSoundStore({
      persistence,
      probeDuration,
      generateBlobId: () => 'blob-1',
      now: () => 1_700_000_000_000,
    })

  beforeEach(() => {
    persistence = createMemoryPersistence()
    store = build(probeReturning(2.5))
  })

  it('accepts an audio file within both caps and stores it under a generated blobId', async () => {
    // Requirement 3.4.
    const meta = await store.add(fakeFile({ name: 'my-bell.wav', type: 'audio/wav', size: 4096 }))

    expect(meta).toMatchObject({
      blobId: 'blob-1',
      name: 'my-bell.wav',
      mimeType: 'audio/wav',
      sizeBytes: 4096,
      durationSeconds: 2.5,
    })

    // ...and it is enumerable for selection, bytes included.
    await expect(store.list()).resolves.toHaveLength(1)
    const record = await store.get('blob-1')
    expect(record?.blob).toBeDefined()
  })

  it('rejects a non-audio MIME type, naming the MIME validation', async () => {
    // Requirement 3.5.
    const failure = await store
      .add(fakeFile({ name: 'clip.mp4', type: 'video/mp4' }))
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SoundUploadError)
    expect((failure as SoundUploadError).reason).toBe('mime')
    expect((failure as SoundUploadError).message).toContain('video/mp4')
    // Nothing was written, so existing assignments cannot have been disturbed.
    await expect(store.list()).resolves.toEqual([])
  })

  it('rejects a file with no MIME type at all', async () => {
    const failure = await store
      .add(fakeFile({ name: 'mystery', type: '' }))
      .catch((error: unknown) => error)

    expect((failure as SoundUploadError).reason).toBe('mime')
    await expect(store.list()).resolves.toEqual([])
  })

  it('rejects a file above the 5 MB cap, naming the size validation', async () => {
    // Requirement 3.5.
    const failure = await store
      .add(fakeFile({ name: 'huge.mp3', size: MAX_UPLOAD_BYTES + 1 }))
      .catch((error: unknown) => error)

    expect((failure as SoundUploadError).reason).toBe('size')
    expect((failure as SoundUploadError).message).toContain('5.0 MB')
    await expect(store.list()).resolves.toEqual([])
  })

  it('accepts a file exactly at the 5 MB cap', async () => {
    // The bound is inclusive (requirement 3.4: "less than or equal to").
    await expect(store.add(fakeFile({ size: MAX_UPLOAD_BYTES }))).resolves.toMatchObject({
      sizeBytes: MAX_UPLOAD_BYTES,
    })
  })

  it('rejects audio longer than 10 decoded seconds, naming the duration validation', async () => {
    // Requirement 3.5.
    store = build(probeReturning(12.5))

    const failure = await store.add(fakeFile({ name: 'song.mp3' })).catch((error: unknown) => error)

    expect((failure as SoundUploadError).reason).toBe('duration')
    expect((failure as SoundUploadError).message).toContain('12.5 s')
    expect((failure as SoundUploadError).message).toContain(`${MAX_DURATION_SECONDS} s`)
    await expect(store.list()).resolves.toEqual([])
  })

  it('accepts audio exactly at the 10 second cap', async () => {
    store = build(probeReturning(MAX_DURATION_SECONDS))
    await expect(store.add(fakeFile({}))).resolves.toMatchObject({
      durationSeconds: MAX_DURATION_SECONDS,
    })
  })

  it('rejects a file that fails to decode, naming the decode validation', async () => {
    // Requirement 3.5.
    store = build(vi.fn(async () => Promise.reject(new Error('EncodingError'))))

    const failure = await store
      .add(fakeFile({ name: 'broken.mp3' }))
      .catch((error: unknown) => error)

    expect((failure as SoundUploadError).reason).toBe('decode')
    expect((failure as SoundUploadError).message).toContain('broken.mp3')
    await expect(store.list()).resolves.toEqual([])
  })

  it('treats a zero or non-finite decoded duration as a decode failure', async () => {
    store = build(probeReturning(0))
    await expect(store.add(fakeFile({}))).rejects.toMatchObject({ reason: 'decode' })

    store = build(probeReturning(Number.NaN))
    await expect(store.add(fakeFile({}))).rejects.toMatchObject({ reason: 'decode' })
  })

  it('checks the MIME type before spending time decoding', async () => {
    // A wrong-type file that is also oversized reports the MIME failure, and the probe is
    // never called — the cheap gates run first.
    const probe = probeReturning(1)
    store = build(probe)

    await expect(
      store.add(fakeFile({ type: 'application/pdf', size: MAX_UPLOAD_BYTES + 10 }))
    ).rejects.toMatchObject({ reason: 'mime' })
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('custom sound store enumeration and deletion', () => {
  it('lists uploads newest first and deletes by blobId', async () => {
    // Requirement 3.4.
    let clock = 1_000
    let counter = 0
    const store = createCustomSoundStore({
      persistence: createMemoryPersistence(),
      probeDuration: probeReturning(1),
      generateBlobId: () => `blob-${(counter += 1)}`,
      now: () => (clock += 1_000),
    })

    await store.add(fakeFile({ name: 'first.mp3' }))
    await store.add(fakeFile({ name: 'second.mp3' }))

    expect((await store.list()).map((meta) => meta.name)).toEqual(['second.mp3', 'first.mp3'])

    await store.remove('blob-2')
    expect((await store.list()).map((meta) => meta.name)).toEqual(['first.mp3'])
    await expect(store.get('blob-2')).resolves.toBeNull()

    // Deleting an unknown id is a no-op, not an error.
    await expect(store.remove('blob-nope')).resolves.toBeUndefined()
  })
})
