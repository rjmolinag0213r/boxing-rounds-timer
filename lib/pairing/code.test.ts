/**
 * Properties 1–7 and 22 of the design, plus the code module's boundary cases.
 *
 * Everything here runs against the real module with no test double: `lib/pairing/code.ts`
 * imports `node:crypto` and nothing else, which is precisely what makes the security-critical
 * half of this feature testable with no database and no mock.
 *
 * **Validates: Requirements 1.1–1.15, 2.1, 2.2, 2.3, 2.4**
 */

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  PAIRING_REJECTION_BOUND,
  formatCode,
  generateCode,
  hashCode,
  isExpired,
  normalizeCode,
} from '@/lib/pairing/code'

/* -------------------------------------------------------------------------- */
/* Generators                                                                  */
/* -------------------------------------------------------------------------- */

/** An arbitrary syntactically valid code: 8 symbols drawn from the alphabet. */
const anyValidCode = (): fc.Arbitrary<string> =>
  fc
    .array(fc.integer({ min: 0, max: PAIRING_ALPHABET.length - 1 }), {
      minLength: PAIRING_CODE_LENGTH,
      maxLength: PAIRING_CODE_LENGTH,
    })
    .map((indices) => indices.map((index) => PAIRING_ALPHABET[index]).join(''))

/** An arbitrary byte. */
const anyByte = (): fc.Arbitrary<number> => fc.integer({ min: 0, max: 255 })

/**
 * A byte stream long enough to yield a whole code however unlucky the rejections are, built
 * so that at least `PAIRING_CODE_LENGTH` bytes fall below the rejection bound. A stream of
 * exclusively rejected bytes could never terminate rejection sampling, by definition, so it
 * is out of the property's domain rather than a counterexample to it.
 */
const anySufficientByteStream = (): fc.Arbitrary<number[]> =>
  fc
    .tuple(
      fc.array(anyByte(), { minLength: 0, maxLength: 40 }),
      fc.array(fc.integer({ min: 0, max: PAIRING_REJECTION_BOUND - 1 }), {
        minLength: PAIRING_CODE_LENGTH,
        maxLength: PAIRING_CODE_LENGTH + 8,
      })
    )
    .map(([noise, acceptable]) => [...noise, ...acceptable])

/**
 * A byte source that hands out successive slices of `stream`, cycling once exhausted so the
 * source can never starve the caller.
 */
const streamSource = (stream: readonly number[]): ((size: number) => Buffer) => {
  let cursor = 0
  return (size: number) => {
    const out = Buffer.alloc(size)
    for (let index = 0; index < size; index += 1) {
      out[index] = stream[cursor % stream.length]
      cursor += 1
    }
    return out
  }
}

/** What rejection sampling *should* produce from a stream, computed independently. */
const expectedCodeFrom = (stream: readonly number[]): string =>
  stream
    .filter((byte) => byte < PAIRING_REJECTION_BOUND)
    .slice(0, PAIRING_CODE_LENGTH)
    .map((byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length])
    .join('')

/**
 * "Format noise": the same code as a user might actually type it — arbitrary letter casing,
 * with dashes and spaces sprinkled at arbitrary positions, including leading and trailing.
 */
const withFormatNoise = (code: string): fc.Arbitrary<string> =>
  fc
    .tuple(
      // One casing decision per character.
      fc.array(fc.boolean(), { minLength: code.length, maxLength: code.length }),
      // A run of separators to insert at each of the code.length + 1 gaps.
      fc.array(fc.array(fc.constantFrom('-', ' ', '\t', '\n'), { maxLength: 2 }), {
        minLength: code.length + 1,
        maxLength: code.length + 1,
      })
    )
    .map(([lowerCase, separators]) => {
      let noisy = separators[0].join('')
      for (let index = 0; index < code.length; index += 1) {
        const character = code[index]
        noisy += lowerCase[index] ? character.toLowerCase() : character
        noisy += separators[index + 1].join('')
      }
      return noisy
    })

/** Plausible expiry instants (2001-09-09 … 2027-01-01). */
const anyInstant = (): fc.Arbitrary<number> =>
  fc.integer({ min: 1_000_000_000_000, max: 1_800_000_000_000 })

/* -------------------------------------------------------------------------- */
/* Property 1                                                                  */
/* -------------------------------------------------------------------------- */

describe('Property 1: Generated codes obey the alphabet and length', () => {
  /**
   * **Property 1: Generated codes obey the alphabet and length**
   *
   * **Validates: Requirements 1.2, 1.3**
   */
  it('returns 8 characters, all drawn from the alphabet, for any byte source', () => {
    fc.assert(
      fc.property(anySufficientByteStream(), (stream) => {
        const code = generateCode(streamSource(stream))

        expect(code).toHaveLength(PAIRING_CODE_LENGTH)
        for (const character of code) {
          expect(PAIRING_ALPHABET).toContain(character)
        }
      }),
      { numRuns: 300 }
    )
  })

  it('never emits an excluded glyph, whatever the byte source', () => {
    fc.assert(
      fc.property(anySufficientByteStream(), (stream) => {
        expect(generateCode(streamSource(stream))).not.toMatch(/[01ILO]/)
      }),
      { numRuns: 300 }
    )
  })

  it('is 8 characters of the alphabet when drawing from the real CSPRNG', () => {
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const code = generateCode()
      expect(code).toHaveLength(PAIRING_CODE_LENGTH)
      expect(code).toMatch(new RegExp(`^[${PAIRING_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`))
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Property 2                                                                  */
/* -------------------------------------------------------------------------- */

describe('Property 2: Code generation is uniform over the keyspace', () => {
  /**
   * **Property 2: Code generation is uniform over the keyspace**
   *
   * **Validates: Requirements 1.4, 1.5**
   *
   * Asserted as a bound on the maximum positional deviation from `1/31`, not as an exact
   * equality — the sample is finite, so an exact equality would be a flake generator.
   */
  it('keeps every symbol within tolerance of 1/31 at every position', () => {
    const sampleSize = 6200
    const symbols = PAIRING_ALPHABET.length
    const expectedShare = 1 / symbols

    // counts[position][symbolIndex]
    const counts: number[][] = Array.from({ length: PAIRING_CODE_LENGTH }, () =>
      Array.from({ length: symbols }, () => 0)
    )

    for (let iteration = 0; iteration < sampleSize; iteration += 1) {
      const code = generateCode(nodeRandomBytes)
      for (let position = 0; position < PAIRING_CODE_LENGTH; position += 1) {
        counts[position][PAIRING_ALPHABET.indexOf(code[position])] += 1
      }
    }

    // 1/31 ≈ 0.032258; the standard error at n = 6200 is ≈ 0.00224, so 0.015 is a ~6.7σ
    // bound: loose enough never to flake, tight enough that a `% 31` bias (which would
    // skew the first 8 symbols by ~1/32 of their share) fails it.
    const tolerance = 0.015
    let worstDeviation = 0

    for (let position = 0; position < PAIRING_CODE_LENGTH; position += 1) {
      for (let symbol = 0; symbol < symbols; symbol += 1) {
        const deviation = Math.abs(counts[position][symbol] / sampleSize - expectedShare)
        worstDeviation = Math.max(worstDeviation, deviation)
      }
    }

    expect(worstDeviation).toBeLessThan(tolerance)
  })

  it('lets no byte at or above the rejection bound contribute a symbol', () => {
    // Every byte in [248, 255] is offered first and must be discarded, so the code is
    // determined entirely by the acceptable bytes that follow.
    const rejected = [248, 249, 250, 251, 252, 253, 254, 255]
    const accepted = [0, 1, 2, 3, 4, 5, 6, 7]

    expect(generateCode(streamSource([...rejected, ...accepted]))).toBe('23456789')
    expect(PAIRING_REJECTION_BOUND).toBe(248)
    // 248 is the largest multiple of 31 not exceeding 256 — the bound the keyspace maths
    // in the design depends on.
    expect(PAIRING_REJECTION_BOUND % PAIRING_ALPHABET.length).toBe(0)
    expect(PAIRING_REJECTION_BOUND + PAIRING_ALPHABET.length).toBeGreaterThan(256)
  })

  it('maps the acceptable bytes of any stream in order, discarding the rest', () => {
    fc.assert(
      fc.property(anySufficientByteStream(), (stream) => {
        expect(generateCode(streamSource(stream))).toBe(expectedCodeFrom(stream))
      }),
      { numRuns: 300 }
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Property 3                                                                  */
/* -------------------------------------------------------------------------- */

describe('Property 3: Distinct codes collide only at the expected rate', () => {
  /**
   * **Property 3: Distinct codes collide only at the expected rate**
   *
   * **Validates: Requirements 1.6**
   *
   * With `n = 4000` against a `31^8 ≈ 8.53 × 10^11` keyspace, the birthday probability of a
   * collision is `≈ n²/2K ≈ 9 × 10^-6`, so "all distinct" is a safe assertion rather than a
   * hopeful one.
   */
  it('returns distinct codes across a sample far below the birthday bound', () => {
    const sampleSize = 4000
    const seen = new Set<string>()

    for (let iteration = 0; iteration < sampleSize; iteration += 1) {
      seen.add(generateCode())
    }

    expect(seen.size).toBe(sampleSize)
  })
})

/* -------------------------------------------------------------------------- */
/* Property 4                                                                  */
/* -------------------------------------------------------------------------- */

describe('Property 4: Normalization is idempotent and format-insensitive', () => {
  /**
   * **Property 4: Normalization is idempotent and format-insensitive**
   *
   * **Validates: Requirements 1.10, 1.11**
   */
  it('recovers the same canonical code from any casing and any separator placement', () => {
    fc.assert(
      fc.property(
        anyValidCode().chain((code) => fc.tuple(fc.constant(code), withFormatNoise(code))),
        ([code, noisy]) => {
          expect(normalizeCode(noisy)).toBe(code)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('is idempotent wherever it returns a value', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          anyValidCode().chain((code) => withFormatNoise(code)),
          fc.string(),
          fc.string({ minLength: 8, maxLength: 8 })
        ),
        (input) => {
          const once = normalizeCode(input)
          if (once === null) return
          expect(normalizeCode(once)).toBe(once)
        }
      ),
      { numRuns: 500 }
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Property 5                                                                  */
/* -------------------------------------------------------------------------- */

describe('Property 5: Normalization never repairs an excluded glyph', () => {
  /**
   * **Property 5: Normalization never repairs an excluded glyph**
   *
   * **Validates: Requirements 1.12**
   *
   * The failure this guards against is not an inconvenience: silently "correcting" `O` to a
   * valid symbol could join a user to a stranger's sync space.
   */
  it('returns null for any input containing O, I, or L in either case', () => {
    fc.assert(
      fc.property(
        anyValidCode(),
        fc.integer({ min: 0, max: PAIRING_CODE_LENGTH - 1 }),
        fc.constantFrom('O', 'I', 'L', 'o', 'i', 'l'),
        (code, position, glyph) => {
          // Substitute the glyph in, so the length stays plausible and only the excluded
          // character can be responsible for the rejection.
          const corrupted = code.slice(0, position) + glyph + code.slice(position + 1)
          expect(normalizeCode(corrupted)).toBeNull()
        }
      ),
      { numRuns: 400 }
    )
  })

  it('returns null for an otherwise valid code with an excluded glyph inserted', () => {
    fc.assert(
      fc.property(
        anyValidCode(),
        fc.integer({ min: 0, max: PAIRING_CODE_LENGTH }),
        fc.constantFrom('O', 'I', 'L', '0', '1'),
        (code, position, glyph) => {
          expect(normalizeCode(code.slice(0, position) + glyph + code.slice(position))).toBeNull()
        }
      ),
      { numRuns: 400 }
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Property 6                                                                  */
/* -------------------------------------------------------------------------- */

describe('Property 6: Normalization is total', () => {
  /**
   * **Property 6: Normalization is total**
   *
   * **Validates: Requirements 1.13**
   */
  const assertTotal = (input: string): void => {
    const result = normalizeCode(input)
    if (result === null) return
    expect(result).toHaveLength(PAIRING_CODE_LENGTH)
    for (const character of result) {
      expect(PAIRING_ALPHABET).toContain(character)
    }
  }

  it('returns a valid code or null, and never throws, for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => assertTotal(input)).not.toThrow()
      }),
      { numRuns: 500 }
    )
  })

  it('returns a valid code or null, and never throws, for arbitrary Unicode', () => {
    fc.assert(
      // `unit: 'binary'` draws from the whole code-point range, including astral planes and
      // lone surrogates — the widest string domain fast-check offers.
      fc.property(fc.string({ unit: 'binary' }), (input) => {
        expect(() => assertTotal(input)).not.toThrow()
      }),
      { numRuns: 500 }
    )
  })

  it.each([
    ['the empty string', ''],
    ['a single space', ' '],
    ['a lone dash', '-'],
    ['separators only', ' - - \t\n'],
    ['a 10,000-character string', 'A'.repeat(10_000)],
    ['10,000 separators', '-'.repeat(10_000)],
    ['a lone surrogate pair', '\u{1F94A}'],
  ])('handles %s without throwing', (_label, input) => {
    expect(() => assertTotal(input)).not.toThrow()
    // None of these is a code, so each must normalize to null.
    expect(normalizeCode(input)).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* Property 7                                                                  */
/* -------------------------------------------------------------------------- */

describe('Property 7: Expiry is a monotone step function of time', () => {
  /**
   * **Property 7: Expiry is a monotone step function of time**
   *
   * **Validates: Requirements 2.3, 2.4**
   */
  it('once expired, stays expired for every later time', () => {
    fc.assert(
      fc.property(anyInstant(), anyInstant(), anyInstant(), (expiresAt, a, b) => {
        const t1 = new Date(Math.min(a, b))
        const t2 = new Date(Math.max(a, b))
        const deadline = new Date(expiresAt)

        if (isExpired(deadline, t1)) {
          expect(isExpired(deadline, t2)).toBe(true)
        }
      }),
      { numRuns: 500 }
    )
  })

  it('reports expired exactly when now is at or after expiresAt', () => {
    fc.assert(
      fc.property(anyInstant(), anyInstant(), (expiresAt, now) => {
        expect(isExpired(new Date(expiresAt), new Date(now))).toBe(now >= expiresAt)
      }),
      { numRuns: 500 }
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Property 22                                                                 */
/* -------------------------------------------------------------------------- */

describe('Property 22: Code formatting round-trips', () => {
  /**
   * **Property 22: Code formatting round-trips**
   *
   * **Validates: Requirements 1.15**
   */
  it('normalizes the formatter output back to the original code', () => {
    fc.assert(
      fc.property(anyValidCode(), (code) => {
        expect(normalizeCode(formatCode(code))).toBe(code)
      }),
      { numRuns: 500 }
    )
  })

  it('round-trips every generated code through display form', () => {
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const code = generateCode()
      expect(normalizeCode(formatCode(code))).toBe(code)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Boundary cases (task 2.10)                                                  */
/* -------------------------------------------------------------------------- */

describe('hashCode (requirement 1.7)', () => {
  it('returns 64 lowercase hexadecimal characters', () => {
    fc.assert(
      fc.property(anyValidCode(), (code) => {
        const digest = hashCode(code)
        expect(digest).toHaveLength(64)
        expect(digest).toMatch(/^[0-9a-f]{64}$/)
      }),
      { numRuns: 200 }
    )
  })

  it('is deterministic and distinguishes distinct codes', () => {
    expect(hashCode('23456789')).toBe(hashCode('23456789'))
    // Independently computed, so the assertion pins the construction (plain SHA-256 over the
    // UTF-8 bytes of the canonical code) rather than merely restating the implementation.
    expect(hashCode('23456789')).toBe(
      createHash('sha256').update('23456789', 'utf8').digest('hex')
    )
    expect(hashCode('23456789')).toBe(
      'f14f286ca435d1fa3b9d8041e8f06aa0af7ab28ea8edcd7e11fd485a100b632b'
    )
    expect(hashCode('23456789')).not.toBe(hashCode('23456782'))
  })
})

describe('formatCode (requirement 1.14)', () => {
  it('groups exactly four, a dash, then four', () => {
    fc.assert(
      fc.property(anyValidCode(), (code) => {
        const formatted = formatCode(code)
        expect(formatted).toHaveLength(PAIRING_CODE_LENGTH + 1)
        expect(formatted[4]).toBe('-')
        expect(formatted.split('-')).toEqual([code.slice(0, 4), code.slice(4)])
      }),
      { numRuns: 200 }
    )
  })

  it('leaves an input of another length untouched rather than mangling it', () => {
    expect(formatCode('')).toBe('')
    expect(formatCode('ABC')).toBe('ABC')
    expect(formatCode('ABCD-2345')).toBe('ABCD-2345')
  })
})

describe('isExpired at the boundary (requirement 2.4)', () => {
  it('reports expired at exactly expiresAt', () => {
    const deadline = new Date(1_700_000_000_000)
    expect(isExpired(deadline, new Date(deadline.getTime() - 1))).toBe(false)
    expect(isExpired(deadline, new Date(deadline.getTime()))).toBe(true)
    expect(isExpired(deadline, new Date(deadline.getTime() + 1))).toBe(true)
  })
})

describe('the module constants (requirements 1.2, 1.3, 2.1, 2.2)', () => {
  it('fixes the TTL at ten minutes', () => {
    expect(PAIRING_CODE_TTL_MS).toBe(600_000)
  })

  it('fixes the alphabet at the 31 unambiguous symbols', () => {
    expect(PAIRING_ALPHABET).toBe('23456789ABCDEFGHJKMNPQRSTUVWXYZ')
    expect(PAIRING_ALPHABET).toHaveLength(31)
    expect(new Set(PAIRING_ALPHABET).size).toBe(31)
    for (const excluded of ['0', '1', 'I', 'L', 'O']) {
      expect(PAIRING_ALPHABET).not.toContain(excluded)
    }
  })

  it('fixes the code length at 8, giving a 31^8 keyspace', () => {
    expect(PAIRING_CODE_LENGTH).toBe(8)
    expect(PAIRING_ALPHABET.length ** PAIRING_CODE_LENGTH).toBe(852_891_037_441)
  })
})
