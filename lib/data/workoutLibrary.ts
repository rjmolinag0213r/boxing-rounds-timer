'use client'

/**
 * The one workout list the whole app shares.
 *
 * Before this module the timer view and the workout builder each held their *own* copy of the
 * saved-workout list and each called `loadPresets`/`savePresets` directly. That was harmless
 * while only the timer was mounted, but tab navigation (requirement 10.1) puts both on screen
 * in the same session, and two independent copies of the same list clobber each other: the
 * builder's save wrote `[...itsOwnCopy, newWorkout]`, silently dropping anything the timer had
 * saved since mount, and the timer's save did the same in reverse.
 *
 * The fix is a single store, module-scoped so every mounted view observes the same array, with
 * all persistence routed through the shared {@link getWorkoutRepository} rather than through
 * `savePresets`. Routing through the repository is what makes a save from either view
 * local-first *and* mirrored to the signed-in user's account (requirements 8.1, 8.2) — the
 * builder previously bypassed that entirely.
 *
 * `DEFAULT_PRESETS` seeds an empty library on first load, so a new install has the Boxing and
 * MMA defaults to start from and the list has exactly one source of truth from then on.
 *
 * Requirements: 5.8, 5.9, 8.1, 8.2, 10.1
 */

import { useCallback, useEffect, useState } from 'react'

import { DEFAULT_PRESETS, type Preset } from '@/lib/presets'
import { getWorkoutRepository } from './repositoryClient'
import type { WorkoutRepository } from './workoutRepository'

/** The published list. `null` until the first load resolves. */
let workouts: Preset[] | null = null
/** De-duplicates concurrent first loads (three views mount at once behind the tabs). */
let inFlight: Promise<Preset[]> | null = null
const listeners = new Set<(next: Preset[]) => void>()
/** Test seam: lets a test drive the store without the client singleton. */
let repositoryOverride: WorkoutRepository | null = null

const repository = (): WorkoutRepository => repositoryOverride ?? getWorkoutRepository()

/** The current list — the defaults are *not* substituted here, only by {@link loadWorkouts}. */
export function getWorkoutsSnapshot(): Preset[] {
  return workouts ?? []
}

/** Subscribes to list changes. Returns the unsubscribe function. */
export function subscribeWorkouts(listener: (next: Preset[]) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function publish(next: Preset[]): void {
  workouts = next
  for (const listener of listeners) listener(next)
}

const upsert = (list: Preset[], workout: Preset): Preset[] =>
  list.some((existing) => existing.id === workout.id)
    ? list.map((existing) => (existing.id === workout.id ? workout : existing))
    : [...list, workout]

/**
 * Loads the library, seeding an empty repository with the built-in defaults.
 *
 * Concurrent callers share one request, and a repository failure degrades to an empty list
 * rather than throwing into a render.
 */
export function loadWorkouts(): Promise<Preset[]> {
  if (workouts !== null) return Promise.resolve(workouts)
  if (inFlight !== null) return inFlight

  inFlight = (async () => {
    const repo = repository()
    let stored: Preset[] = []
    try {
      stored = (await repo.listWorkouts()) ?? []
    } catch {
      stored = []
    }

    if (stored.length > 0) {
      publish(stored)
      return stored
    }

    // A first-run library: publish the defaults immediately so nothing renders empty, then
    // persist them so every later write operates on one list instead of re-seeding.
    publish(DEFAULT_PRESETS)
    for (const preset of DEFAULT_PRESETS) {
      try {
        await repo.saveWorkout(preset)
      } catch {
        // Storage full or unavailable: the defaults still show, they just are not durable.
      }
    }
    return getWorkoutsSnapshot()
  })()

  const settle = inFlight
  void settle.finally(() => {
    if (inFlight === settle) inFlight = null
  })
  return settle
}

/** Re-reads the library from the repository, discarding the cached list. */
export async function refreshWorkouts(): Promise<Preset[]> {
  workouts = null
  inFlight = null
  return loadWorkouts()
}

/**
 * Saves a workout, publishing it to every mounted view before the write is awaited.
 *
 * The repository call is issued *synchronously* so the local write lands in the same task as
 * the user's click; only the optional remote mirror is asynchronous (requirement 8.2).
 */
export function saveWorkout(workout: Preset): Promise<void> {
  publish(upsert(getWorkoutsSnapshot(), workout))
  return repository()
    .saveWorkout(workout)
    .catch(() => {
      // Local-first: the record is already published and stored on this device. A failure
      // here concerns syncing only, which the repository tracks as pending itself.
    })
}

/**
 * Deletes a workout. Session records are untouched — they carry their own name and type
 * snapshot, so history survives the deletion (requirements 5.9, 6.6).
 */
export function deleteWorkout(id: string): Promise<void> {
  publish(getWorkoutsSnapshot().filter((workout) => workout.id !== id))
  return repository()
    .deleteWorkout(id)
    .catch(() => {
      // As above: the deletion is already reflected locally.
    })
}

/** Test seam: points the store at an injected repository. */
export function setWorkoutLibraryRepositoryForTests(repo: WorkoutRepository | null): void {
  repositoryOverride = repo
}

/** Test seam: drops the cached list, the in-flight load and every subscriber. */
export function resetWorkoutLibraryForTests(): void {
  workouts = null
  inFlight = null
  listeners.clear()
  repositoryOverride = null
}

export interface WorkoutLibrary {
  workouts: Preset[]
  /** `true` until the first load resolves. */
  loading: boolean
  saveWorkout: (workout: Preset) => Promise<void>
  deleteWorkout: (id: string) => Promise<void>
  refresh: () => Promise<void>
}

/**
 * Binds a component to the shared library.
 *
 * Every view calling this hook sees the same array and the same writes, which is what makes
 * "save in the Builder, use it in the Timer" work without either view knowing the other
 * exists.
 */
export function useWorkoutLibrary(): WorkoutLibrary {
  const [list, setList] = useState<Preset[]>(getWorkoutsSnapshot)
  const [loading, setLoading] = useState<boolean>(() => getWorkoutsSnapshot().length === 0)

  useEffect(() => {
    const unsubscribe = subscribeWorkouts(setList)
    let cancelled = false
    void loadWorkouts().then((loaded) => {
      if (cancelled) return
      setList(loaded)
      setLoading(false)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const save = useCallback((workout: Preset) => saveWorkout(workout), [])
  const remove = useCallback((id: string) => deleteWorkout(id), [])
  const refresh = useCallback(async () => {
    await refreshWorkouts()
  }, [])

  return { workouts: list, loading, saveWorkout: save, deleteWorkout: remove, refresh }
}
