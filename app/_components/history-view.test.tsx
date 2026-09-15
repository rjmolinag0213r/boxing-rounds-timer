/**
 * Tests for the history view (task 11.2).
 *
 * Each case pins one of the view's states: the ordered list with its per-row facts, the empty
 * invitation, the refresh failure that keeps this device's sessions on screen, the deleted-workout
 * row that still reads correctly, and the unsynchronized indicator.
 *
 * The repository is injected as a plain object, so nothing here touches localStorage, IndexedDB,
 * or the network — the view is exercised against real data, not mocks of its own internals.
 *
 * Requirements: 6.6, 7.1, 7.2, 7.3, 7.5, 7.6, 7.7, 8.10, 10.8
 */

import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import HistoryView from './history-view'
import type { WorkoutSessionDTO } from '@/lib/types'

/** Wednesday 12 June 2024, 10:00 local — its Monday-start week is 10–16 June. */
const NOW = new Date(2024, 5, 12, 10, 0, 0).getTime()

function session(
  overrides: Partial<WorkoutSessionDTO> & { id: string; endedAt: number }
): WorkoutSessionDTO {
  return {
    workoutId: null,
    workoutName: 'Classic 12×3',
    type: 'BOXING',
    roundsPlanned: 12,
    roundsCompleted: 12,
    totalDurationMs: 3_723_000,
    completed: true,
    startedAt: overrides.endedAt - 1_000,
    ...overrides,
  }
}

describe('HistoryView', () => {
  it('invites a first workout when there is no history', async () => {
    render(<HistoryView repository={{ listHistory: async () => [] }} now={() => NOW} />)

    expect(await screen.findByText('No workouts yet')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Workout history' })).not.toBeInTheDocument()
  })

  it('lists sessions newest first with each row’s stored facts and the week’s totals', async () => {
    const sessions = [
      session({
        id: 'older',
        endedAt: new Date(2024, 5, 10, 9, 0, 0).getTime(),
        workoutName: 'Monday bag work',
      }),
      session({
        id: 'newer',
        endedAt: new Date(2024, 5, 12, 9, 0, 0).getTime(),
        workoutName: 'MMA Regular 3×5',
        type: 'MMA',
        completed: false,
        roundsCompleted: 4,
        totalDurationMs: 65_000,
      }),
    ]

    render(<HistoryView repository={{ listHistory: async () => sessions }} now={() => NOW} />)

    const rows = await waitFor(() => {
      const found = screen.getAllByRole('listitem')
      expect(found).toHaveLength(2)
      return found
    })

    // Requirement 7.1: newest end timestamp first, regardless of the order supplied.
    expect(rows[0]).toHaveTextContent('MMA Regular 3×5')
    expect(rows[1]).toHaveTextContent('Monday bag work')

    // Requirement 7.2: date, type badge, completed/planned rounds, formatted duration, name.
    expect(rows[0]).toHaveTextContent('Wed 12 Jun, 09:00')
    expect(rows[0]).toHaveTextContent('MMA')
    expect(rows[0]).toHaveTextContent('4/12 rounds')
    expect(rows[0]).toHaveTextContent('01:05')
    expect(rows[1]).toHaveTextContent('1:02:03')

    // Requirement 7.7: stopped and finished are labelled, not just colour-coded.
    expect(rows[0]).toHaveTextContent('Stopped')
    expect(rows[1]).toHaveTextContent('Finished')

    // Requirement 7.3: 2 sessions, 16 completed rounds, 1:03:08 of training this week.
    expect(screen.getByText('16')).toBeInTheDocument()
    expect(screen.getByText('1:03:08')).toBeInTheDocument()
  })

  it('still reads correctly for a session whose workout definition was deleted', async () => {
    const orphan = session({
      id: 'orphan',
      endedAt: NOW - 60_000,
      workoutId: null,
      workoutName: 'Deleted sparring plan',
      type: 'MMA',
    })

    render(<HistoryView repository={{ listHistory: async () => [orphan] }} now={() => NOW} />)

    // Requirement 6.6: the row renders from the session's own snapshot fields.
    const row = await screen.findByRole('listitem')
    expect(row).toHaveTextContent('Deleted sparring plan')
    expect(row).toHaveTextContent('MMA')
  })

  it('keeps this device’s sessions visible when a refresh fails, and clears the error on retry', async () => {
    const stored = [session({ id: 'stored', endedAt: NOW - 60_000 })]
    const listHistory = vi
      .fn<() => Promise<WorkoutSessionDTO[]>>()
      .mockResolvedValueOnce(stored)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(stored)

    render(<HistoryView repository={{ listHistory }} now={() => NOW} />)
    await screen.findByRole('listitem')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh workout history' }))
    })

    // Requirement 7.6: the failure is reported and the local session stays on screen.
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not refresh your history')
    expect(alert).toHaveTextContent('Showing the sessions saved on this device.')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry loading workout history' }))
    })

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(listHistory).toHaveBeenCalledTimes(3)
  })

  it('surfaces an unsynchronized indicator for an account with pending records', async () => {
    render(
      <HistoryView
        now={() => NOW}
        repository={{
          listHistory: async () => [],
          getState: () => ({
            mode: 'authenticated',
            userId: 'user-1',
            synchronized: false,
            pendingCount: 2,
            lastError: 'Service unavailable',
          }),
          subscribe: () => () => {},
        }}
      />
    )

    // Requirement 8.10.
    expect(await screen.findByText('2 not synced')).toBeInTheDocument()
  })
})
