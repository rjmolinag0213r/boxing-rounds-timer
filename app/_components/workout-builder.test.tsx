/**
 * Behavioural tests for the workout builder (task 7.2).
 *
 * These cover the three user-visible contracts the schema tests cannot reach: the type
 * selector lists that type's defaults as starting points (5.5), a rejected submission shows
 * the field message and stores nothing while keeping the entered values (5.7), and an accepted
 * submission persists the workout (5.6).
 *
 * Requirements: 5.1, 5.2, 5.5, 5.6, 5.7
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import WorkoutBuilder from '@/app/_components/workout-builder'
import { STORAGE_KEY, type Preset } from '@/lib/presets'

const storedWorkouts = (): Preset[] => {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  return raw === null ? [] : (JSON.parse(raw) as Preset[])
}

const nameInput = () => screen.getByLabelText('Name') as HTMLInputElement
const save = () => fireEvent.click(screen.getByRole('button', { name: /save workout/i }))

describe('WorkoutBuilder', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('offers BOXING, MMA and CUSTOM and lists the selected type’s defaults', () => {
    render(<WorkoutBuilder />)

    const options = screen.getAllByRole('radio')
    expect(options.map((o) => o.textContent)).toEqual(['Boxing', 'MMA', 'Custom'])
    expect(options[0]).toHaveAttribute('aria-checked', 'true')

    // Requirement 5.5: the Boxing defaults are the starting points.
    expect(screen.getByText('Boxing — Classic 12×3')).toBeInTheDocument()
    expect(screen.queryByText('MMA — Championship 5×5')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'MMA' }))

    expect(screen.getByText('MMA — Championship 5×5')).toBeInTheDocument()
    expect(screen.getByText('MMA — Regular 3×5')).toBeInTheDocument()
    expect(screen.queryByText('Boxing — Classic 12×3')).not.toBeInTheDocument()
  })

  it('loads a starting point into the editable fields', () => {
    render(<WorkoutBuilder />)

    fireEvent.click(screen.getByText('Boxing — Speed 10×1'))

    expect((screen.getByLabelText('Rounds') as HTMLInputElement).value).toBe('10')
    expect((screen.getByLabelText('Round duration minutes') as HTMLInputElement).value).toBe('1')
    expect((screen.getByLabelText('Rest duration seconds') as HTMLInputElement).value).toBe('30')
    expect(nameInput().value).toContain('Speed 10×1')
  })

  it('shows the field message and persists nothing when the name is empty', () => {
    const onSaved = vi.fn()
    render(<WorkoutBuilder onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText('Rounds'), { target: { value: '7' } })
    save()

    // Requirement 5.7: the message names the field, the values survive, nothing is stored.
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required')
    expect((screen.getByLabelText('Rounds') as HTMLInputElement).value).toBe('7')
    expect(storedWorkouts()).toEqual([])
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('shows the field message for an out-of-bounds round count', () => {
    render(<WorkoutBuilder />)

    fireEvent.change(nameInput(), { target: { value: 'Marathon' } })
    fireEvent.change(screen.getByLabelText('Rounds'), { target: { value: '120' } })
    save()

    expect(screen.getByRole('alert')).toHaveTextContent('Rounds must be at most 99')
    expect(storedWorkouts()).toEqual([])
  })

  it('persists a valid workout with its type and prep duration', () => {
    const onSaved = vi.fn()
    render(<WorkoutBuilder onSaved={onSaved} />)

    fireEvent.click(screen.getByRole('radio', { name: 'MMA' }))
    fireEvent.change(nameInput(), { target: { value: '  Title fight  ' } })
    save()

    // Requirement 5.6: the workout is persisted (alongside the seeded defaults).
    const saved = storedWorkouts()
    const created = saved.find((workout) => workout.name === 'Title fight')

    expect(created).toMatchObject({
      name: 'Title fight',
      type: 'MMA',
      rounds: 3,
      roundSeconds: 300,
      restSeconds: 60,
      prepSeconds: 10,
    })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
