# Requirements Document

## Introduction

This document specifies the requirements for the **device-pairing-sync** feature of the
`boxing-rounds-timer` application (Next.js 14.2 App Router, TypeScript, Prisma/Postgres). The
requirements are **derived from the approved design document** (`design.md`) in this directory and
encode the decisions argued there.

The feature lets one user's devices share their workouts and history with **no account, no password,
no email address, and no OAuth provider**. Device A asks the server for a short **pairing code** and
displays it with a countdown; the user types that code on device B; both devices then resolve to the
same anonymous **sync space**, and the application's existing two-way reconcile engine merges their
data and keeps it merged.

**Verified starting state.** `SyncingRepository` in `lib/data/workoutRepository.ts` already contains
a complete two-way reconcile engine, but it is only ever given an identity by an OAuth session, and
no provider is configured — so in practice every device is an island. `Workout.userId` and
`WorkoutSession.userId` are nullable but carry a foreign key to `User(id)`, so an identity must *be*
a `User` row to own records. `lib/db.ts` exposes a lazy `getPrismaClient()` that returns `null` when
`DATABASE_URL` is unset, and the production build must keep succeeding in that state. 311 tests
currently pass with no live database.

**The binding constraint is zero additional configuration.** Every choice below is made so that the
feature adds **zero environment variables**: the device credential is an opaque random token verified
by database lookup rather than a signed token (which would need a signing secret), and rate-limit
state lives in the existing Postgres database rather than in Redis.

Requirement numbering is stable and is cited by the design document's correctness properties and by
the implementation task list. See [Traceability](#traceability) and [Out of Scope](#out-of-scope).

---

## Glossary

Every subject of a SHALL statement in this document is defined here.

### Domain terms

- **Pairing_Alphabet**: The 31 unambiguous symbols `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, being Crockford
  Base32 less `0`, `1`, `I`, `L`, and `O` — the glyph pairs a human confuses when copying a code from
  one screen to another.
- **Pairing_Code**: A short-lived, single-use bearer capability to join one Sync_Space. Eight
  characters drawn from the Pairing_Alphabet, displayed grouped as `XXXX-XXXX`. Persisted as the
  `PairingCode` model, which stores only the code's SHA-256 digest.
- **Sync_Space**: An anonymous, account-free identity shared by every device paired into it.
  Persisted as the `SyncSpace` model, 1:1 with a Shadow_User.
- **Shadow_User**: The `User` row a Sync_Space owns. Its `id` is the value written into
  `Workout.userId` and `WorkoutSession.userId` for paired callers. It carries no `Account` and no
  `Session` row.
- **Paired_Device**: One browser holding a Device_Token for a Sync_Space. Persisted as the
  `PairedDevice` model.
- **Device_Token**: An opaque 32-byte CSPRNG value, base64url-encoded, that authorises a browser as a
  Paired_Device. Stored only as its SHA-256 digest.
- **Device_Cookie**: The cookie named `bx_device` that carries the Device_Token to the browser.
- **Pairing_Attempt_Ledger**: The `PairingAttempt` table — one row per claim or code-creation
  attempt, keyed by a hashed client address — that backs rate limiting without Redis.
- **Live_Code**: A Pairing_Code that is simultaneously unconsumed and unexpired.

### Server components

- **Pairing_Code_Generator**: `generateCode()` in `lib/pairing/code.ts`. Produces a Pairing_Code from
  an injected random byte source. Pure apart from that source.
- **Code_Normalizer**: `normalizeCode()` in `lib/pairing/code.ts`. Canonicalizes user input into an
  8-character code or `null`.
- **Code_Formatter**: `formatCode()` in `lib/pairing/code.ts`. Renders a code for display only.
- **Expiry_Predicate**: `isExpired(expiresAt, now)` in `lib/pairing/code.ts`.
- **Rate_Limiter**: `lib/pairing/rateLimit.ts`, comprising the pure decision function `evaluate()`,
  the Backoff_Function, and the I/O shell `createRateLimiter()` that reads and writes the
  Pairing_Attempt_Ledger.
- **Backoff_Function**: `backoffMs(consecutiveFailures)` in `lib/pairing/rateLimit.ts`.
- **Claim_Request_Schema**: The zod schema validating the body of a claim request.
- **Identity_Resolver**: `resolveIdentity()` in `lib/identity.ts`. Collapses an OAuth session and a
  Device_Cookie into one `userId`, returning `anonymous`, `authenticated`, or `database-error`.
- **Device_Token_Issuer**: The token-minting and cookie-setting path in `lib/identity.ts`
  (`createSyncSpaceWithDevice()` and `enrolDevice()`) together with the shared cookie options.
- **Pairing_Code_Endpoint**: `POST /api/pair/code`.
- **Pairing_Claim_Endpoint**: `POST /api/pair/claim`.
- **Pairing_Identity_Endpoint**: `GET /api/pair/identity`.
- **Pairing_Devices_Endpoint**: `GET /api/pair/devices`.
- **Device_Unlink_Endpoint**: `DELETE /api/pair/devices/[id]`.
- **Space_Rotation_Endpoint**: `POST /api/pair/rotate`.
- **Data_Routes**: The existing record routes `/api/workouts`, `/api/workouts/[id]`, and
  `/api/sessions`.
- **Pairing_Modules**: Every new module added by this feature under `lib/pairing/`, `lib/identity.ts`,
  `app/api/pair/`, and `lib/data/pairingClient.ts`.
- **Database**: The Postgres instance reached through the existing lazy `getPrismaClient()`.
- **Prisma_Schema**: `prisma/schema.prisma`.
- **Pairing_Migration**: The additive migration directory this feature adds under
  `prisma/migrations/`.

### Client components

- **Pairing_Client**: `lib/data/pairingClient.ts` (new) — the typed fetch wrapper over the pairing
  routes, with the error taxonomy `PairingRateLimitedError`, `PairingInvalidCodeError`,
  `PairingUnavailableError`, `PairingLimitError`.
- **Repository_Client**: `lib/data/repositoryClient.ts` — the singleton accessor that probes identity
  and hands it to the Syncing_Repository.
- **Syncing_Repository**: The existing `SyncingRepository` class in `lib/data/workoutRepository.ts`,
  including `setSession()`, `subscribe()`, and `retryPending()`.
- **Reconcile_Engine**: The existing `reconcile()` merge path inside the Syncing_Repository.
- **Sync_State**: The existing state object the Syncing_Repository publishes to subscribers:
  `{ mode, userId, synchronized, pendingCount, lastError }`, extended by this feature with one
  optional `source` field.
- **Sync_Settings_View**: `app/_components/sync-settings.tsx` (new) — the Sync surface.
- **Boxing_App_Shell**: `app/_components/boxing-app.tsx` — the Tabs shell and header that hosts the
  theme toggle, mute control, and Sounds trigger.
- **Timer_View**, **Workout_Builder_View**, **History_View**: The three existing tab surfaces.

### Process terms

- **Pairing_Feature**: The whole change set specified by this document, considered as a deliverable.
- **Build_Pipeline**: `npm run build` (`prisma generate && next build`).
- **Test_Suite**: `vitest --run`, with `fast-check` and `jsdom` as already configured.
- **Typecheck_Command**: `npm run typecheck`, which runs both the application and test TypeScript
  projects.

---

## Accepted Constraints and Residual Risk

Stated before the requirements because it shapes the parameters they encode.

A Pairing_Code is a **bearer capability, not an authentication factor**. It proves nothing about who
holds it. Anyone who obtains a Live_Code — by reading it over the user's shoulder, from a screen
share, or from a photograph of the screen — can join the Sync_Space and thereafter read and modify
that user's workouts and history. There is no second factor and no identity to check the code
against. **This is accepted deliberately**, because the protected asset is low-sensitivity (round
counts, rest durations, workout names, session timestamps, and no personal identifier), the exposure
window is one 10-minute TTL, and requiring OAuth for a personal timer meant in practice that nobody
signed in and the feature went unused.

The mitigations required below — high entropy, short TTL, single use, rate limiting, uniform failure
responses, and revocation — address the threat this model *can* address: **a remote attacker guessing
codes**. They do not, and cannot, defend against an attacker who can see the screen. Requirement 10
(unlink and rotate) is the user's remedy if that residual risk is ever realised.

Two further exposures are accepted and not mitigated: synced records are stored server-side in
plaintext and are therefore readable by the database operator, and `ipHash` is an unkeyed hash of an
IP address and so is reversible by brute force — retention, not the hash, is the control
(requirement 15.7).

---

## Requirements

### Requirement 1: Pairing Code Generation, Normalization, and Storage

**User Story:** As a user pairing a second device, I want a short code that I can read off one screen
and type into another without transcription mistakes, and that an attacker cannot guess, so that
sharing my workouts is quick and still safe.

#### Acceptance Criteria

1. THE Pairing_Code_Generator SHALL draw its bytes from a cryptographically secure pseudo-random byte
   source supplied as a parameter, defaulting to `node:crypto`'s `randomBytes`.
2. THE Pairing_Code_Generator SHALL return a code of exactly 8 characters.
3. THE Pairing_Code_Generator SHALL return codes in which every character is a member of the
   Pairing_Alphabet, so that no returned code contains `0`, `1`, `I`, `L`, or `O`.
4. WHEN a drawn byte has a value of 248 or greater, THE Pairing_Code_Generator SHALL discard that byte
   and draw a replacement, so that only bytes below 248 — the largest multiple of 31 not exceeding
   256 — contribute a symbol.
5. THE Pairing_Code_Generator SHALL produce codes uniformly distributed over the
   `31^8 = 852,891,037,441` element keyspace, such that across a large sample each of the 31 symbols
   appears at each of the 8 positions with a frequency within statistical tolerance of `1/31`.
6. WHEN a number of codes far below the birthday bound of the keyspace is generated independently,
   THE Pairing_Code_Generator SHALL return distinct codes for every generation.
7. THE Pairing_Code_Endpoint SHALL persist each generated code solely as its SHA-256 digest, written
   to `PairingCode.codeHash` as 64 lowercase hexadecimal characters.
8. THE Pairing_Code_Endpoint SHALL emit the plaintext code only in the body of the `201` response that
   created it.
9. WHEN code input is received, THE Code_Normalizer SHALL remove dashes and whitespace, upper-case the
   remaining characters, and return the result when it is exactly 8 characters all drawn from the
   Pairing_Alphabet.
10. WHERE the normalization of an input is non-null, THE Code_Normalizer SHALL return that same value
    when applied again to its own result.
11. WHEN one code is presented in any letter casing and with dashes or spaces at any positions, THE
    Code_Normalizer SHALL return one identical canonical 8-character value for every such variation.
12. IF an input contains `O`, `I`, or `L`, THEN THE Code_Normalizer SHALL return `null` rather than
    mapping the glyph onto a member of the Pairing_Alphabet.
13. THE Code_Normalizer SHALL return either a valid 8-character code or `null` for every string input
    — including the empty string, whitespace-only strings, lone separators, arbitrary Unicode, and
    strings of 10,000 characters — and SHALL complete without throwing.
14. THE Code_Formatter SHALL render an 8-character code as two groups of four separated by a single
    dash (`XXXX-XXXX`), for display only.
15. WHEN the Code_Normalizer is applied to the Code_Formatter's output for a code, THE Code_Normalizer
    SHALL return that same code.
16. IF the caller's Sync_Space already holds 3 Live_Codes, THEN THE Pairing_Code_Endpoint SHALL respond
    with status `409` and create no further code, so that the count of Live_Codes underlying the
    brute-force arithmetic stays bounded at 3 per Sync_Space.

---

### Requirement 2: Pairing Code Expiry

**User Story:** As a user, I want a displayed code to stop working shortly after I stop using it, so
that a code left on screen or photographed is not a lasting way into my data.

#### Acceptance Criteria

1. WHEN a Pairing_Code is created, THE Pairing_Code_Endpoint SHALL set `expiresAt` to the creation
   time plus 600,000 milliseconds (10 minutes).
2. THE Pairing_Code_Endpoint SHALL derive the time to live exclusively from the server-side constant
   `PAIRING_CODE_TTL_MS`, taking no value from a request body, query string, or header.
3. THE Pairing_Claim_Endpoint SHALL enforce expiry inside the `WHERE` clause of its single consumption
   statement, by requiring `expiresAt` to be greater than the current time.
4. THE Expiry_Predicate SHALL report a Pairing_Code as expired exactly when the evaluated time is at
   or after `expiresAt`, and SHALL continue to report it as expired for every later evaluated time.
5. THE Pairing_Code_Endpoint SHALL treat the deletion of Pairing_Code rows whose `expiresAt` is more
   than 24 hours in the past as housekeeping only, running it opportunistically at most once per hour
   per process on code creation.
6. WHILE housekeeping deletion has not yet run for an expired Pairing_Code, THE Pairing_Claim_Endpoint
   SHALL still reject claims of that code, so that expiry enforcement depends on no background job.
7. THE Pairing_Code_Endpoint SHALL include `expiresAt` as epoch milliseconds and `ttlMs` in its `201`
   response body, so that a client can render a countdown without polling the server.

---

### Requirement 3: Single-Use Consumption

**User Story:** As a user, I want a code to work exactly once, so that a code someone saw earlier
cannot be replayed and two devices cannot race into my sync space on one code.

#### Acceptance Criteria

1. THE Pairing_Claim_Endpoint SHALL consume a Pairing_Code with a single conditional update statement
   that matches on `codeHash`, on `consumedAt` being null, and on `expiresAt` being greater than the
   current time, and that sets `consumedAt` to the current time.
2. WHEN two or more claim requests for one Pairing_Code are processed concurrently, THE
   Pairing_Claim_Endpoint SHALL report a matched row count of 1 to exactly one of those requests and a
   matched row count of 0 to every other.
3. WHEN a Pairing_Code has been consumed, THE Pairing_Claim_Endpoint SHALL report a matched row count
   of 0 for every subsequent claim of that code, for all time.
4. THE Pairing_Claim_Endpoint SHALL determine consumption without issuing a read of the code row ahead
   of the conditional update.
5. THE Pairing_Claim_Endpoint SHALL enrol a Paired_Device only on the path where the matched row count
   is 1, so that no partial state is reachable from a losing claim.
6. WHEN a claim's matched row count is 0, THE Pairing_Claim_Endpoint SHALL leave every Pairing_Code row
   unchanged.

---

### Requirement 4: Rate Limiting and Backoff

**User Story:** As a user, I want the server to make guessing codes hopeless, so that the small
keyspace a human can type is still safe from a remote script.

#### Acceptance Criteria

1. THE Rate_Limiter SHALL evaluate claim attempts against a per-address rule of 5 attempts per
   rolling 10 minutes.
2. THE Rate_Limiter SHALL evaluate claim attempts against a per-address rule of 20 attempts per
   rolling 24 hours.
3. THE Rate_Limiter SHALL evaluate claim attempts against a global rule of 60 attempts per rolling 1
   minute.
4. THE Rate_Limiter SHALL evaluate code-creation attempts against a per-address rule of 10 attempts
   per rolling 1 hour.
5. THE Space_Rotation_Endpoint SHALL apply the code-creation rule of criterion 4.4, because rotation
   mints an identity.
6. WHEN an applicable rule's in-window attempt count has reached its maximum, THE
   Pairing_Claim_Endpoint SHALL respond with status `429`, a `Retry-After` header carrying whole
   seconds, and a body of `{ error, reason: 'rate-limited', retryAfterSeconds }`.
7. THE Rate_Limiter SHALL report a verdict of allowed exactly when, for every rule, the number of
   recorded attempts within that rule's window is strictly less than that rule's maximum.
8. WHEN a verdict is denied, THE Rate_Limiter SHALL report `retryAfterSeconds` of at least 1, equal to
   the whole seconds until the oldest in-window attempt of the binding rule leaves its window, such
   that re-evaluating after that delay with no further attempts recorded yields an allowed verdict.
9. WHILE the evaluated `now` is held fixed, THE Rate_Limiter SHALL respond to the addition of an
   attempt timestamp by either leaving the verdict unchanged or changing it from allowed to denied.
10. WHEN every recorded attempt is older than each rule's window relative to the evaluated `now`, THE
    Rate_Limiter SHALL report a verdict of allowed with `retryAfterSeconds` of 0.
11. WHEN a client address has produced 3 or more consecutive recent failures, THE
    Pairing_Claim_Endpoint SHALL delay each subsequent response within the window by
    `min(2^(n-3) x 500, 4000)` milliseconds, where `n` is the consecutive-failure count, applying the
    delay before the response is written.
12. THE Backoff_Function SHALL return a value that is non-decreasing in the consecutive-failure count
    and that is at most 4000 milliseconds for every count.
13. THE Pairing_Claim_Endpoint SHALL record exactly one Pairing_Attempt_Ledger row for every claim it
    processes past the rate-limit check, on the success path and on every failure path alike, with
    `succeeded` reflecting the outcome.
14. THE Rate_Limiter SHALL count an attempt identically regardless of the reason the attempt failed.
15. THE Pairing_Claim_Endpoint SHALL evaluate the rate limit before performing any code
    normalization, hashing, or database lookup, so that a limited caller learns nothing about codes.
16. THE Rate_Limiter SHALL decide verdicts in a pure function over a list of attempt timestamps, a
    rule set, and an injected `now` value, reading no clock of its own.
17. THE Rate_Limiter SHALL hold the Pairing_Attempt_Ledger in the application's existing Postgres
    Database, introducing no external service and no environment variable.
18. THE Rate_Limiter SHALL derive `ipHash` as a truncated SHA-256 digest of the client address read
    from the `x-forwarded-for` header.
19. WHEN a pairing request receives status `429`, THE Pairing_Client SHALL raise
    `PairingRateLimitedError` carrying the `retryAfterSeconds` value.

---

### Requirement 5: Enumeration and Timing Resistance

**User Story:** As a user, I want a rejected code to tell an attacker nothing, so that the claim
endpoint cannot be used to discover which codes exist.

#### Acceptance Criteria

1. IF a claimed code is absent, expired, or already consumed, THEN THE Pairing_Claim_Endpoint SHALL
   respond with status `400` and the body
   `{ error: 'That code is not valid. Ask for a new one.', reason: 'invalid-code' }`.
2. IF a claim body is malformed — not JSON, missing `code`, carrying a non-string `code`, or carrying
   a `code` longer than 32 characters — THEN THE Pairing_Claim_Endpoint SHALL respond with the status,
   body, and headers specified in criterion 5.1, rather than a field-named validation error.
3. THE Pairing_Claim_Endpoint SHALL emit a byte-identical status, body, and header set for every
   failing claim, whatever the cause.
4. WHEN the Code_Normalizer returns `null` for a submitted code, THE Pairing_Claim_Endpoint SHALL
   substitute a sentinel hash that matches no stored row and SHALL continue to the consumption
   statement, so that syntactic and semantic failures traverse one path.
5. THE Pairing_Claim_Endpoint SHALL perform the same sequence of work on every path that reaches the
   Database — normalize, hash, one indexed conditional update — with no earlier return.
6. THE Claim_Request_Schema SHALL validate only that `code` is a string of at least 1 and at most 32
   characters after trimming, leaving alphabet and length checks to the Code_Normalizer.
7. THE Pairing_Claim_Endpoint SHALL derive its failure response from the matched row count alone,
   which is 0 for absent, expired, and consumed codes alike, so that the handler holds no value
   distinguishing the three causes.
8. WHEN a claim fails, THE Sync_Settings_View SHALL display the server's single uniform message and
   SHALL add no more specific reason.

---

### Requirement 6: Device Token Issue and Verification

**User Story:** As a user, I want my paired device to stay paired without me holding a password, and I
want a database leak to yield no usable credential.

#### Acceptance Criteria

1. WHEN a Paired_Device is enrolled, THE Device_Token_Issuer SHALL generate a Device_Token of 32 bytes
   from `crypto.randomBytes` and encode it as base64url, giving 256 bits of entropy.
2. THE Device_Token_Issuer SHALL persist a Device_Token solely as its SHA-256 digest, written to
   `PairedDevice.tokenHash` as 64 lowercase hexadecimal characters.
3. THE Device_Token_Issuer SHALL compute `tokenHash` as a deterministic function of the Device_Token
   and SHALL confine the raw Device_Token to the Set-Cookie header of the issuing response.
4. THE Device_Token_Issuer SHALL hash Device_Tokens with SHA-256 rather than a slow key-derivation
   function, justified by the token's 256 bits of CSPRNG entropy and by verification occurring on
   every API request.
5. WHEN a response issues a Device_Token, THE Device_Cookie SHALL be set with name `bx_device`,
   `httpOnly` true, `sameSite` `lax`, `path` `/`, and `maxAge` 34,560,000 seconds (400 days).
6. WHILE `NODE_ENV` equals `production`, THE Device_Cookie SHALL additionally carry `secure` true.
7. WHEN a request carries a Device_Cookie, THE Identity_Resolver SHALL verify it by one indexed lookup
   of its SHA-256 digest against the unique `PairedDevice.tokenHash` column.
8. THE Device_Token_Issuer SHALL implement the credential as an opaque random token verified by
   database lookup, so that no signing secret and therefore no environment variable is introduced.
9. THE Pairing_Modules SHALL obtain random bytes and digests from `node:crypto` alone, using neither
   `jsonwebtoken` nor `bcryptjs`.
10. THE Device_Token_Issuer SHALL derive `PairedDevice.label` from a fixed allow-list mapping of the
    `user-agent` header, as specified in requirement 15.5.

---

### Requirement 7: Identity Resolution and OAuth Precedence

**User Story:** As a developer, I want one function that turns either identity source into a `userId`,
so that the existing data routes need no knowledge of pairing and keep behaving exactly as they do.

#### Acceptance Criteria

1. THE Identity_Resolver SHALL return exactly one of the three kinds `anonymous`, `authenticated`,
   and `database-error`, matching the kinds already returned by `resolveAuth()` in `lib/auth.ts`.
2. WHEN an OAuth session resolves, THE Identity_Resolver SHALL return kind `authenticated` with that
   OAuth user's id and `source` of `oauth`, whether or not a Device_Cookie is also present.
3. WHEN no OAuth session resolves and a presented Device_Cookie's SHA-256 digest matches a live
   Paired_Device, THE Identity_Resolver SHALL return kind `authenticated` with that device's
   Sync_Space `userId`, `source` of `paired`, and that device's id.
4. WHEN neither an OAuth session nor a matching Paired_Device is present, THE Identity_Resolver SHALL
   return kind `anonymous`.
5. WHERE `DATABASE_URL` is unset, THE Identity_Resolver SHALL return kind `anonymous`, treating
   local-only as a supported state.
6. IF a database connectivity fault is raised while resolving identity, THEN THE Identity_Resolver
   SHALL return kind `database-error` carrying the error, so that callers answer `503`.
7. THE Data_Routes SHALL adopt the Identity_Resolver through one aliased import statement each,
   leaving their handler bodies, queries, ownership checks, and status codes unchanged.
8. THE existing `lib/auth.ts` module SHALL remain unmodified, and THE Identity_Resolver SHALL call its
   `resolveAuth()` first as the OAuth path.
9. THE Identity_Resolver SHALL return a `userId` that is always a `User.id`, whether the row behind it
   is an OAuth user or a Sync_Space's Shadow_User.
10. THE Identity_Resolver SHALL write `PairedDevice.lastSeenAt` at most once per hour per device, and
    SHALL complete the request when that write fails.
11. WHERE a request carries both an OAuth session and a Device_Cookie, THE Sync_Settings_View SHALL
    state that the account's workouts are shown and that signing out enables the paired Sync_Space.

---

### Requirement 8: Creating a Code Enrols the Creating Device

**User Story:** As a user showing a code on my phone, I want my phone's existing workouts to reach the
shared space too, so that pairing does not hand my other device an empty library.

#### Acceptance Criteria

1. WHEN an anonymous caller requests a Pairing_Code, THE Pairing_Code_Endpoint SHALL create, in one
   database transaction, a Shadow_User, a Sync_Space bound to that Shadow_User, and a Paired_Device
   for the calling browser.
2. WHEN an anonymous caller requests a Pairing_Code, THE Pairing_Code_Endpoint SHALL set the
   Device_Cookie on the `201` response.
3. THE Pairing_Code_Endpoint SHALL include the caller's resolved `userId` and a `syncAvailable` value
   in its `201` response body, so that the client can call `setSession(userId)` without a further
   request.
4. WHEN a caller that already resolves to a Sync_Space requests a Pairing_Code, THE
   Pairing_Code_Endpoint SHALL create the code within that existing Sync_Space.
5. WHERE a caller resolves with `source` of `oauth` and owns no Sync_Space, THE Pairing_Code_Endpoint
   SHALL create a Sync_Space bound to that caller's existing `User` row, so that pairing extends the
   account rather than forking it.
6. WHEN a Pairing_Code is created for a caller that was anonymous, THE Repository_Client SHALL call the
   existing `SyncingRepository.setSession(userId)`, so that the creating device's local library
   uploads into the new Sync_Space.

---

### Requirement 9: Claiming Joins the Space and Merges the Data

**User Story:** As a user typing a code on my computer, I want both devices to end up holding all of
my workouts and history, so that nothing I recorded on either device is lost.

#### Acceptance Criteria

1. WHEN a claim consumes a Pairing_Code, THE Pairing_Claim_Endpoint SHALL create a Paired_Device in
   that code's Sync_Space.
2. WHEN a claim consumes a Pairing_Code, THE Pairing_Claim_Endpoint SHALL respond with status `200`,
   a body of `{ userId, deviceId, spaceId }`, and the Device_Cookie set.
3. WHEN a claim succeeds, THE Pairing_Client SHALL pass the returned `userId` to the existing
   `SyncingRepository.setSession(userId)`.
4. WHEN reconcile runs for a device holding local record set `A` joining a Sync_Space holding record
   set `B`, THE Syncing_Repository SHALL leave the device and the Sync_Space each holding exactly the
   union of `A` and `B`, keyed by client-generated id.
5. WHEN reconcile runs any number of further times after that union is reached, THE
   Syncing_Repository SHALL leave the records held by the device and the Sync_Space unchanged.
6. WHEN a local record and a server record share a client-generated id, THE Syncing_Repository SHALL
   retain the server's copy, except where the local copy is pending a local write.
7. THE Syncing_Repository SHALL replay recorded offline deletions before merging, so that a workout
   deleted while offline stays deleted.
8. THE Reconcile_Engine SHALL remain unmodified by the Pairing_Feature, which supplies an identity
   rather than new merge logic.
9. THE Sync_Settings_View SHALL state, before the user submits a code, that pairing merges this
   device's workouts and history into the shared space.

---

### Requirement 10: Device Listing, Unlink, and Rotation

**User Story:** As a user, I want to see which devices are paired and to cut one off — or start over
entirely — so that showing a code to the wrong person is recoverable.

#### Acceptance Criteria

1. THE Pairing_Devices_Endpoint SHALL respond with status `200` and a body listing the caller's
   Sync_Space devices, each carrying `id`, `label`, `createdAt`, `lastSeenAt`, and `isCurrent`,
   together with `spaceId` and `rotatedAt`.
2. IF the caller resolves as anonymous, THEN THE Pairing_Devices_Endpoint SHALL respond with status
   `401` through the existing `unauthorized()` helper.
3. WHEN the Device_Unlink_Endpoint receives the id of a Paired_Device in the caller's Sync_Space, THE
   Device_Unlink_Endpoint SHALL delete that Paired_Device and respond with status `200` and a body of
   `{ id, wasCurrent }`.
4. IF a requested device id is absent or belongs to another Sync_Space, THEN THE
   Device_Unlink_Endpoint SHALL respond with status `404` and an identical body for both cases, so
   that ownership is not disclosed.
5. WHEN the unlinked Paired_Device is the caller's own, THE Device_Unlink_Endpoint SHALL clear the
   Device_Cookie on the response.
6. WHEN a Paired_Device row has been deleted, THE Identity_Resolver SHALL return kind `anonymous` for
   every subsequent request carrying that device's Device_Token.
7. WHEN a revoked device's next data request resolves as anonymous, THE Repository_Client SHALL call
   `setSession(null)` and continue in local-only mode with that device's local records retained.
8. WHEN rotation is requested, THE Space_Rotation_Endpoint SHALL perform the whole rotation inside one
   database transaction.
9. WHEN rotation is requested, THE Space_Rotation_Endpoint SHALL create a new Shadow_User and
   Sync_Space and re-point every `Workout` and `WorkoutSession` row of the old identity to the new
   `userId`, so that the caller's record set is preserved exactly.
10. WHEN rotation is requested, THE Space_Rotation_Endpoint SHALL delete every Paired_Device of the old
    Sync_Space.
11. WHEN rotation is requested, THE Space_Rotation_Endpoint SHALL delete every Pairing_Code of the old
    Sync_Space, so that no previously issued code remains claimable.
12. WHEN rotation completes, THE Space_Rotation_Endpoint SHALL enrol the calling browser into the new
    Sync_Space, issue a fresh Device_Cookie, and respond with status `200` and a body of
    `{ userId, spaceId, revokedDevices }`.
13. WHEN rotation completes, THE Space_Rotation_Endpoint SHALL set the new `SyncSpace.rotatedAt` to the
    rotation time.
14. IF the caller resolves as anonymous, THEN THE Space_Rotation_Endpoint SHALL respond with status
    `401`.

---

### Requirement 11: Sync Status Surfacing

**User Story:** As a user, I want to see at a glance whether this device is synced and whether
anything is waiting to upload, so that I can trust the shared space.

#### Acceptance Criteria

1. THE Sync_State SHALL retain its existing fields `mode`, `userId`, `synchronized`, `pendingCount`,
   and `lastError` with unchanged types.
2. THE Sync_State SHALL carry one additional optional field `source`, whose value is `oauth` or
   `paired` and which is left undefined in local-only mode.
3. THE Sync_State `mode` field SHALL retain exactly the two values `local-only` and `authenticated`,
   so that existing consumers and tests continue to compile and pass.
4. WHEN the Sync_State changes, THE Syncing_Repository SHALL notify every subscriber registered
   through the existing `subscribe()`.
5. THE Sync_Settings_View SHALL derive every status value it displays from the Sync_State it receives
   through `subscribe()`.
6. WHILE `pendingCount` is greater than 0, THE Sync_Settings_View SHALL display that count and offer
   a control that calls the existing `retryPending()`.
7. THE Repository_Client SHALL probe the Pairing_Identity_Endpoint to discover the caller's identity,
   in place of its current `/api/auth/session` probe.
8. WHEN the identity probe reports `syncAvailable` of `false`, THE Repository_Client SHALL record sync
   as unavailable and remain in local-only mode.
9. THE Repository_Client SHALL expose the recorded availability value, a subscription to changes in
   it, and a `refreshIdentity()` operation that re-runs the probe after a pair, unlink, or rotate.
10. WHEN the identity probe reports a non-empty `userId`, THE Repository_Client SHALL call
    `setSession(userId)`.
11. IF the identity probe fails or returns a non-JSON body, THEN THE Repository_Client SHALL remain in
    local-only mode.

---

### Requirement 12: The Sync Surface

**User Story:** As a user on a phone, I want pairing to live where device settings already live and to
be usable with one thumb and with a screen reader, so that it feels like the rest of the app.

#### Acceptance Criteria

1. THE Boxing_App_Shell SHALL present a Sync trigger in its header beside the existing Sounds trigger,
   opening a `Dialog` at viewport widths of 640 pixels and above and a bottom-sheet `Drawer` below
   that width.
2. THE Boxing_App_Shell SHALL mount exactly one of the Dialog and the Drawer at any given viewport
   width, so that no accessible name is duplicated.
3. THE Boxing_App_Shell SHALL retain exactly its three existing tabs.
4. THE Sync_Settings_View SHALL present its sections in the order status, generate a code, enter a
   code, paired devices, rotate the sync space.
5. WHILE a generated Pairing_Code has not reached its `expiresAt`, THE Sync_Settings_View SHALL
   display that code in the `XXXX-XXXX` grouping together with the remaining time in minutes and
   seconds.
6. THE Sync_Settings_View SHALL give the countdown region the attributes `role="timer"` and
   `aria-live="off"`.
7. WHEN a displayed Pairing_Code reaches its `expiresAt`, THE Sync_Settings_View SHALL make exactly
   one polite screen-reader announcement and SHALL replace the code with a control that generates a
   new one.
8. THE Sync_Settings_View SHALL compute the countdown from the `expiresAt` value it already holds,
   issuing no request to determine expiry.
9. THE Sync_Settings_View SHALL accept a code through an 8-slot `InputOTP` control grouped four and
   four, and SHALL submit the claim when the eighth character is entered.
10. WHEN a claim fails, THE Sync_Settings_View SHALL render the message in a region carrying
    `role="alert"`.
11. THE Sync_Settings_View SHALL list each Paired_Device with its label, its `lastSeenAt` rendered as
    a relative time, and an unlink control whose accessible name includes that device's label.
12. WHEN the user unlinks the current device, THE Sync_Settings_View SHALL require confirmation through
    an `AlertDialog` first.
13. WHEN the user requests rotation, THE Sync_Settings_View SHALL require confirmation through an
    `AlertDialog` that states every device is unlinked and that the caller's workouts and history move
    to the new Sync_Space.
14. THE Sync_Settings_View SHALL give every interactive element a minimum height of 44 pixels.
15. THE Sync_Settings_View SHALL express every colour through the existing design tokens, containing
    zero literal Tailwind palette classes such as `red-500` and `red-600`.
16. THE Sync_Settings_View SHALL render focus states through the existing `--ring` focus-visible ring
    convention.
17. WHILE the user agent reports `prefers-reduced-motion` of `reduce`, THE Sync_Settings_View SHALL
    render its transitions and animated affordances as static.
18. THE Sync_Settings_View SHALL constrain the Drawer to at most 85 percent of viewport height with
    vertical overflow scrolling.
19. WHERE sync is unavailable on the deployment, THE Sync_Settings_View SHALL replace its pairing
    controls with a single muted explanation.
20. WHEN the user types into the code entry control, THE Sync_Settings_View SHALL upper-case the
    characters for display while leaving the authoritative normalization to the server.

---

### Requirement 13: Offline and Absent-Database Behaviour

**User Story:** As a user of a deployment with no database, or as a user with no connection, I want
the app to keep working on this device and to say plainly that sync is unavailable, so that a
supported state never looks like a fault.

#### Acceptance Criteria

1. WHERE `DATABASE_URL` is unset, THE Pairing_Code_Endpoint, Pairing_Claim_Endpoint,
   Pairing_Devices_Endpoint, Device_Unlink_Endpoint, and Space_Rotation_Endpoint SHALL each respond
   with status `503` through the existing `databaseUnavailable('not-configured')` helper.
2. WHERE `DATABASE_URL` is unset, THE Pairing_Identity_Endpoint SHALL respond with status `200` and a
   body of `{ kind: 'anonymous', userId: null, deviceId: null, syncAvailable: false }`, so that a
   client can distinguish "not configured" from "momentarily unreachable".
3. IF the Database is configured and unreachable, THEN THE pairing routes SHALL respond with status
   `503` and `reason` of `unreachable`.
4. IF the Database is configured and unreachable, THEN THE Data_Routes SHALL respond with status `503`,
   so that a database fault never presents as a sign-out.
5. IF a pairing request fails because the device has no network, THEN THE Pairing_Client SHALL raise
   `PairingUnavailableError` and THE Sync_Settings_View SHALL state that pairing needs a connection
   while everything else keeps working.
6. THE Pairing_Client SHALL leave a failed pairing attempt unqueued, requiring a fresh user action to
   retry.
7. WHILE sync is unavailable, THE Timer_View, Workout_Builder_View, and History_View SHALL continue to
   read and write browser storage.
8. THE Build_Pipeline SHALL complete successfully with no `DATABASE_URL` present.
9. THE Pairing_Modules SHALL reach the Database only through the existing lazy `getPrismaClient()` and
   SHALL handle a `null` client, constructing no Prisma client at import time.
10. THE `lib/pairing/code.ts` module SHALL import `node:crypto` alone, so that it is safe to load in a
    build with no Database.
11. THE Test_Suite SHALL pass with no live Database, keeping the 311 existing tests passing and
    covering new behaviour against a mocked `@/lib/db`.
12. THE Typecheck_Command SHALL succeed for both the application project and the test project.

---

### Requirement 14: Data Isolation

**User Story:** As a user, I want my sync space's records to be visible only to devices paired into
it, so that pairing never exposes my data to a stranger's space or theirs to mine.

#### Acceptance Criteria

1. THE Data_Routes SHALL scope every read and every write by the `userId` returned by the
   Identity_Resolver.
2. WHEN a record is written while scoped to one Sync_Space, THE Data_Routes SHALL omit that record
   from every read scoped to a different Sync_Space.
3. THE Data_Routes SHALL treat a record whose `userId` is null as belonging to no Sync_Space, so that
   no identity-scoped read returns it.
4. IF a caller requests by id a record belonging to another identity, THEN THE Data_Routes SHALL
   respond with status `404`, preserving the existing not-yours behaviour.
5. WHEN a device's Paired_Device row has been deleted, THE Data_Routes SHALL respond with status `401`
   to that device's subsequent requests.
6. THE Pairing_Devices_Endpoint and the Device_Unlink_Endpoint SHALL restrict their effect to the
   caller's own Sync_Space.

---

### Requirement 15: Capacity Caps and Data Retention

**User Story:** As an operator, I want the pairing tables to stay small and to hold as little about
users as possible, so that the feature costs little and leaks little.

#### Acceptance Criteria

1. THE Sync_Space SHALL hold at most 10 Paired_Device rows. The companion cap of 3 Live_Codes per
   Sync_Space is specified in criterion 1.16.
2. IF enrolling a device would raise a Sync_Space above 10 Paired_Device rows, THEN THE
   Pairing_Claim_Endpoint SHALL respond with status `409` and `reason` of `device-limit` and SHALL
   record the attempt as failed.
3. THE Rate_Limiter SHALL delete Pairing_Attempt_Ledger rows whose `createdAt` is more than 24 hours
   in the past.
4. THE Rate_Limiter SHALL run that deletion opportunistically, at most once per hour per process,
   introducing no scheduler and no cron configuration.
5. THE Device_Token_Issuer SHALL set `PairedDevice.label` to a value of at most 64 characters drawn
   from a fixed allow-list of browser and operating-system names plus `Unknown device`.
6. THE Pairing_Modules SHALL persist, for each Paired_Device, only its allow-listed label, its
   timestamps, its Sync_Space reference, and its token digest.
7. THE Pairing_Attempt_Ledger SHALL retain `ipHash` values for at most 24 hours, retention being the
   control that compensates for an unkeyed hash of an IP address being reversible by brute force.
8. IF a Paired_Device is unlinked while a Sync_Space is at its device cap, THEN THE
   Pairing_Claim_Endpoint SHALL admit a subsequent claim, so that the cap is recoverable.

---

### Requirement 16: Identity Data Model, Additive Migration, and Zero Configuration

**User Story:** As a maintainer, I want this feature to add tables and nothing else, so that it
deploys itself, rolls back cleanly, and never asks for a new secret.

#### Acceptance Criteria

1. THE Prisma_Schema SHALL add the models `SyncSpace`, `PairingCode`, `PairedDevice`, and
   `PairingAttempt`, the enum `PairingAttemptKind` with values `CREATE` and `CLAIM`, and one
   back-relation field on `User`.
2. THE Prisma_Schema SHALL leave the `Workout` and `WorkoutSession` models unchanged apart from
   documentation comments, which generate no SQL.
3. THE Sync_Space SHALL relate one-to-one to its Shadow_User through a unique foreign key.
4. WHEN a paired caller writes a record, THE Data_Routes SHALL write that caller's Shadow_User
   `User.id` into `Workout.userId` or `WorkoutSession.userId`, satisfying the existing foreign key to
   `User`.
5. THE Shadow_User SHALL own no `Account` row and no `Session` row, so that `getServerSession` cannot
   return it and no provider can be linked to it.
6. WHEN a Shadow_User row is deleted, THE Database SHALL cascade that deletion to the Sync_Space, its
   Paired_Device rows, its Pairing_Code rows, and its workouts and sessions.
7. THE Pairing_Migration SHALL contain only additive statements — four table creations, one enum
   creation, and their indexes — with no `ALTER` to an existing column and no backfill.
8. THE Pairing_Migration SHALL apply automatically through the existing Railway `preDeployCommand`.
9. THE `PairingCode.codeHash` and `PairedDevice.tokenHash` columns SHALL each carry a unique
   constraint, so that a claim and an identity resolution are each one indexed lookup.
10. THE Pairing_Feature SHALL add zero environment variables.
11. THE Pairing_Feature SHALL add zero runtime dependencies and zero development dependencies.
12. WHEN the four new tables are dropped, THE Identity_Resolver SHALL resolve every caller as
    anonymous and THE Data_Routes SHALL behave as they did before the Pairing_Feature, so that a
    deployed client whose Device_Cookie no longer resolves degrades to local-only mode.
13. THE Pairing_Feature SHALL leave every existing client storage key unchanged, so that a user who
    never opens the Sync surface sees no behavioural difference.

---

## Out of Scope

The following are explicitly excluded. **No requirements are written for them.**

1. **Native iOS Dynamic Island integration.** Requires a native companion application and is
   unrelated to sync.
2. **The Next.js major-version upgrade.** This feature targets the current Next.js 14.2 App Router and
   must not depend on that upgrade landing.
3. **Email and password accounts.** Explicitly rejected in favour of pairing; a password store would
   reintroduce the credential-management burden this feature exists to remove.
4. **End-to-end encryption of synced data.** Noted as possible future hardening. Workouts and history
   are stored server-side in plaintext, so a database compromise exposes them. Encrypting them would
   require deriving a key from the Pairing_Code and keeping it client-side, which breaks the
   "server merges records by id" model the existing Reconcile_Engine depends on and makes a lost
   device an unrecoverable data loss.

Also deferred, and noted here so their absence is deliberate rather than accidental: merging a paired
Sync_Space into an OAuth account (requirement 7.11 states the situation to the user instead), and a
user-facing "delete everything" action (the single-row cascade of criterion 16.6 exists, but is not
surfaced in this iteration).

---

## Traceability

The design document's correctness properties **P1–P22** validate the following acceptance criteria.
The design document carries the same mapping inline, on each property.

| Design property | Validates |
|-----------------|-----------|
| P1 — Generated codes obey the alphabet and length | 1.2, 1.3 |
| P2 — Code generation is uniform over the keyspace | 1.4, 1.5 |
| P3 — Distinct codes collide only at the expected rate | 1.6 |
| P4 — Normalization is idempotent and format-insensitive | 1.10, 1.11 |
| P5 — Normalization never repairs an excluded glyph | 1.12 |
| P6 — Normalization is total | 1.13 |
| P7 — Expiry is a monotone step function of time | 2.3, 2.4 |
| P8 — A code is consumable at most once | 3.1, 3.2, 3.3 |
| P9 — Claim failures are indistinguishable | 5.1, 5.2, 5.3 |
| P10 — Rate-limit accounting never exceeds its budget | 4.1, 4.2, 4.3, 4.7, 4.9 |
| P11 — Rate-limit capacity recovers after the window | 4.10 |
| P12 — Retry-After is a correct lower bound | 4.8 |
| P13 — Backoff is monotone and bounded | 4.12 |
| P14 — Pairing merges to the union, idempotently | 9.4, 9.5 |
| P15 — Sync spaces are isolated | 14.1, 14.2, 14.6 |
| P16 — OAuth takes precedence deterministically | 7.2, 7.3, 7.4 |
| P17 — A database fault never resolves as anonymous | 7.6, 13.4 |
| P18 — Revocation is immediately effective | 10.6, 14.5 |
| P19 — Token hashing is deterministic and one-way in storage | 6.2, 6.3 |
| P20 — Issued cookies always carry their security attributes | 6.5, 6.6 |
| P21 — Rotation preserves records and revokes devices | 10.9, 10.10, 10.11 |
| P22 — Code formatting round-trips | 1.15 |

Acceptance criteria outside the P1–P22 set are verified by the unit, component, and seam tests
described in the design's Testing Strategy: route status-code matrices (requirements 8, 10, 13, 15),
the exact `Set-Cookie` attribute string (6.5, 6.6), the device-label allow-list (15.5), the countdown
and accessibility assertions (12.5–12.18), and deterministic schema, configuration, and build
assertions (13.8–13.12, 16.1–16.13).
