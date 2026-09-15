import { render, screen } from '@testing-library/react'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { cn, formatDuration } from '@/lib/utils'

describe('test toolchain smoke test', () => {
  it('resolves the @/* path alias to project modules', () => {
    expect(cn('a', 'b')).toBe('a b')
    expect(formatDuration(3661)).toBe('01:01:01')
  })

  it('runs in a jsdom environment with jest-dom matchers', () => {
    render(<p>ready to box</p>)
    expect(screen.getByText('ready to box')).toBeInTheDocument()
  })

  it('runs fast-check properties', () => {
    fc.assert(
      fc.property(fc.nat({ max: 359_999 }), (seconds) => {
        expect(formatDuration(seconds)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
      })
    )
  })
})
