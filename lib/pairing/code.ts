/**
 * Pairing-code primitives: generate, normalize, hash, format, expire.
 *
 * The module imports `node:crypto` and nothing else. That is deliberate on two counts. It
 * makes every function here property-testable with no test double at all, and it keeps the
 * module safe to load during a build that has no `DATABASE_URL` — nothing in this file can
 * reach for a Prisma client, because it has no way to name one.
 *
 * A pairing code is a **bearer capability, not an authentication factor**: it proves nothing
 * about who holds it. What this module contributes to the security argument is entropy
 * (uniform over `31^8 ≈ 8.5 × 10^11`) and a canonical form. Single use, expiry enforcement,
 * and rate limiting live elsewhere and are what actually make guessing hopeless.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.9, 1.12, 1.14, 2.1, 2.2, 13.10
 */

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'

/**
 * The 31 unambiguous symbols: Crockford Base32 less every glyph a human confuses when
 * copying a code off one screen and onto another — `0`/`O` and `1`/`I`/`L`.
 *
 * 31 is not a power of two, which is the whole reason {@link generateCode} rejection-samples
 * rather than masking bits. Re-admitting `L` to get a tidy 32 was rejected: four lines of
 * arithmetic are cheaper than the most common transcription error there is.
 */
export const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

/** Codes are 8 symbols, displayed grouped as `XXXX-XXXX`. */
export const PAIRING_CODE_LENGTH = 8

/** 10 minutes. A server-side constant; never read from a request (requirement 2.2). */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000

/**
 * The rejection bound: 248 is the largest multiple of 31 not exceeding 256, so bytes in
 * `[248, 255]` are discarded rather than folded. Without this, `byte % 31` would favour the
 * first 8 symbols and the keyspace arithmetic in the design would not hold.
 *
 * Expected waste is `8/256 = 3.1%` of drawn bytes, which is irrelevant.
 */
export const PAIRING_REJECTION_BOUND = 248

/** How the code is split for display: two groups of four. */
const GROUP_SIZE = 4

/** A source of random bytes, injected so generation is testable without stubbing modules. */
export type RandomByteSource = (size: number) => Buffer

/**
 * A uniformly random pairing code.
 *
 * Rejection-sampled: a byte at or above {@link PAIRING_REJECTION_BOUND} contributes nothing
 * and a replacement is drawn, so every symbol is equally likely (requirements 1.4, 1.5).
 *
 * Bytes are drawn in batches because the common case needs only slightly more than 8 of
 * them; the loop keeps drawing until 8 symbols are in hand, so an adversarially unlucky —
 * or deliberately hostile — byte source cannot make it return a short code.
 */
export function generateCode(randomBytes: RandomByteSource = nodeRandomBytes): string {
  let code = ''

  while (code.length < PAIRING_CODE_LENGTH) {
    const needed = PAIRING_CODE_LENGTH - code.length
    // A small surplus absorbs the ~3% rejection rate without a second syscall in practice.
    const batch = randomBytes(needed + 2)

    for (const byte of batch) {
      if (code.length === PAIRING_CODE_LENGTH) break
      if (byte >= PAIRING_REJECTION_BOUND) continue
      code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]
    }
  }

  return code
}

/**
 * The glyph folding applied after upper-casing, per the design's table.
 *
 * Note what this does *not* do: it never repairs an excluded glyph into a valid symbol. `O`
 * folds to `0` and `I`/`L` fold to `1`, and neither `0` nor `1` is in the alphabet, so the
 * code is rejected. Silently "correcting" `O` to `Q` could join a user to a stranger's sync
 * space, which is far worse than asking them to retype (requirement 1.12).
 */
const GLYPH_FOLDING: Readonly<Record<string, string>> = {
  O: '0',
  I: '1',
  L: '1',
}

/** Characters that are presentational grouping only and are stripped before validation. */
const isSeparator = (character: string): boolean => character === '-' || /\s/.test(character)

/**
 * Canonicalizes user input into an 8-character code, or `null` when the input is not one.
 *
 * Total by construction: every branch either returns a valid code or `null`, and nothing here
 * can throw for any string — empty, whitespace-only, 10,000 characters, arbitrary Unicode
 * (requirement 1.13). Idempotent, because its own output contains no separators, no
 * lower-case, and no foldable glyph (requirement 1.10).
 */
export function normalizeCode(input: string): string | null {
  if (typeof input !== 'string') return null

  let canonical = ''

  for (const character of input) {
    if (isSeparator(character)) continue

    const upper = character.toUpperCase()
    const folded = GLYPH_FOLDING[upper] ?? upper

    // Bail as soon as the result cannot be a code. This is a *syntactic* rejection, and the
    // claim endpoint deliberately does not return early on it — see the handler order in the
    // design — so an early exit here leaks nothing.
    if (!PAIRING_ALPHABET.includes(folded)) return null

    canonical += folded
    if (canonical.length > PAIRING_CODE_LENGTH) return null
  }

  return canonical.length === PAIRING_CODE_LENGTH ? canonical : null
}

/**
 * SHA-256 hex of a normalized code: 64 lowercase hexadecimal characters.
 *
 * A fast unkeyed hash is correct here. The preimage is a uniform draw from an
 * `8.5 × 10^11`-element space, so there is no dictionary for a slow KDF to defend against,
 * and a plain digest permits the unique index that makes a claim one indexed lookup.
 */
export function hashCode(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/**
 * Groups a code as `XXXX-XXXX`. Presentational only — the dash is stripped on input and this
 * form is never hashed (requirement 1.14).
 *
 * Inputs of other lengths are returned unchanged rather than mangled; this is a display
 * helper and has no business throwing.
 */
export function formatCode(code: string): string {
  if (code.length !== PAIRING_CODE_LENGTH) return code
  return `${code.slice(0, GROUP_SIZE)}-${code.slice(GROUP_SIZE)}`
}

/**
 * True exactly when `now` is at or past `expiresAt` — the boundary instant counts as expired.
 *
 * This predicate is for display and for tests. Claim-time expiry is enforced inside the
 * consumption statement's `WHERE` clause, never by calling this first, so expiry never
 * depends on a sweep having run (requirements 2.3, 2.6).
 */
export function isExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime()
}
