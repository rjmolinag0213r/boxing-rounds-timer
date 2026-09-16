# Pairing Code 500 Fix — Bugfix Design

## Overview

Every pairing action on the deployed app fails with `500 {"error":"Unexpected server error"}` while
`/api/health` reports `sync-capable` and `/api/pair/identity` reports `syncAvailable: true`. The
pairing tables are absent at runtime; the first database touch on both pairing write paths is the
rate limiter's ledger read (`db.pairingAttempt.findMany`), so the request throws before any pairing
logic runs, and Prisma's `P2021` ("table does not exist") falls through the shared classifier's
connectivity-only ladder into the generic `500`.

The fix has four movements, in descending order of importance:

1. **Make the migration actually apply, and make its failure loud** (requirement 2.9). A Node
   pre-deploy wrapper replaces the bare `prisma migrate deploy`, handles the P3005 baseline case,
   verifies with `prisma migrate status`, and exits non-zero on anything it cannot prove.
2. **Classify the fault** (2.3, 2.4). `P2021`/`P2022` become a third category alongside
   unreachable and unknown, answering `503` with a new reason and emitting exactly one redacted
   operator diagnostic.
3. **Attribute it honestly to the user** (2.5, 2.6). The client stops folding this `503` into
   `unreachable`, and the Sync panel gets copy that says the *server* is not ready, that it is not
   the user's fault, and that local data is safe.
4. **Stop the probes from lying** (2.7, 2.8). The identity probe verifies schema readiness through
   a bounded, self-healing cache; `/api/health` gains additive readiness fields it reads from that
   cache without ever touching the database.

The status code stays `503` — see [Decision 1](#decision-1-503-with-a-new-reason-not-500-with-a-code).
Nothing about the pairing scheme itself changes; `.kiro/specs/device-pairing-sync/design.md` remains
authoritative for intended behaviour.

## Glossary

- **Bug_Condition (C)** — a pairing request arriving at a deployment where the database is
  configured *and* reachable *but* the pairing relations are absent. Formalized in
  [Bug Condition](#bug-condition).
- **Property (P)** — the desired behaviour under C: a classified `503`, one redacted diagnostic,
  truthful probes, and honest user-facing copy.
- **Preservation** — the three non-buggy deployment states (no database configured; configured but
  unreachable; healthy and fully migrated) must behave byte-identically after the fix. Enumerated
  in `bugfix.md` §3.
- **`Schema_Not_Migrated`** — the new reason value, `'schema-not-migrated'`, that discriminates this
  fault from `'not-configured'` and `'unreachable'` on the wire.
- **`Sync_Unavailable_Reason`** — the closed union of `503` reasons, defined once and imported by
  both server and client so the two cannot drift.
- **`Schema_Readiness`** — the cached four-state verdict `'ready' | 'not-migrated' | 'unreachable' |
  'unknown'` produced by the readiness probe.
- **`errorResponse(error, context?)`** — the shared classifier in `lib/data/apiResponses.ts`; the
  single funnel through which every pairing and data route maps a thrown error to a response.
- **`isDatabaseUnreachable(error)`** — the existing connectivity predicate (`P10xx`,
  `PrismaClientInitializationError`, `ECONNREFUSED`/`ENOTFOUND`, message regex). **Not modified.**
- **`pairingAttempt`** — the rate-limiter ledger table. It is the *first* relation every pairing
  write path touches, which is why it is also the readiness probe's subject.
- **`prismaFake`** — the in-memory Prisma stand-in at `lib/pairing/__fixtures__/prismaFake.ts`.
  There is no live Postgres in the sandbox or in CI, so this fake is the only way the bug condition
  can be reproduced under test.

## Bug Details

### Bug Condition

The bug manifests when a pairing request lands on a deployment that believes it can sync
(`DATABASE_URL` set, Prisma client constructed, server reachable) but whose pairing relations
(`SyncSpace`, `PairingCode`, `PairedDevice`, `PairingAttempt`) do not exist. Prisma raises `P2021`
on the first touch; `isDatabaseUnreachable` returns false for it; `errorResponse` therefore returns
the generic `500`, logs nothing, and both probes continue to advertise sync as available.

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT: X of type PairingRequest
  OUTPUT: boolean

  RETURN X.databaseConfigured   = TRUE
     AND X.databaseReachable    = TRUE
     AND X.pairingSchemaPresent = FALSE
END FUNCTION
```

The three conjuncts map onto observable code states: `getPrismaClient() !== null`
(configured), a query that returns or throws a *non-connectivity* error (reachable), and a thrown
`P2021`/`P2022` on any pairing relation (schema absent).

### Examples

- **Generate a code.** `POST /api/pair/code` → expected `201` with a plaintext code; actual
  `500 {"error":"Unexpected server error"}`, thrown from `limiter.check` →
  `db.pairingAttempt.findMany` before a code is ever generated (defect 1.1).
- **Claim a code.** `POST /api/pair/claim` → expected `400`-or-`200` per the claim taxonomy; actual
  `500` at the same ledger read, before the submitted code is even parsed (defect 1.2).
- **Operator polling health.** `GET /api/health` → expected a signal that pairing is broken; actual
  `200 {"database":"configured","mode":"sync-capable"}` — a green light over a dead feature
  (defect 1.8).
- **Client capability probe.** `GET /api/pair/identity` → expected sync reported unavailable;
  actual `200 {"syncAvailable":true}`, because the route only checks that a client object exists
  (defect 1.7).
- **The user's view.** Sync panel → *"Sync is unavailable right now. Your data stays on this
  device."* under both controls: the copy for a deployment with no database, shown for a
  deployment whose database is fine (defects 1.5, 1.6).
- **Edge case — a healthy deployment.** Identical requests on a migrated database must be
  completely unaffected: `201`, plaintext code once, digest-only storage, device enrolled, cookie
  set (preservation 3.4).

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviours:**

- **No database configured** — every pairing route still answers `503 {reason:'not-configured'}`;
  identity still answers `200` with the exact local-only body; the Sync panel still shows its
  single muted local-only line (3.2).
- **Configured but unreachable** — still `503 {reason:'unreachable'}`, still retryable on the
  client, `resolveIdentity()` still returns `database-error` and never `anonymous` (3.3).
- **Healthy and migrated** — `POST /api/pair/code` still `201`; plaintext emitted exactly once;
  only the SHA-256 digest persisted; TTL from `PAIRING_CODE_TTL_MS` alone; calling device enrolled;
  cookie set for a previously anonymous caller (3.4).
- **Claim rejections** — one uniform `400` for absent/expired/consumed/malformed. The new reason
  must never become a new oracle about code state (3.5).
- **Rate limiting** — same caps, same windows, limit checked before any code processing,
  `Retry-After` in whole seconds, one ledger row per processed attempt, fail-closed with no client
  (3.6).
- **`/api/health`** — still `200`, still **never touches the database**. `app/api/data-routes.test.ts`
  asserts `getPrismaClient` is *not called* by this route; that assertion must keep passing
  unmodified (3.8).
- **`/api/pair/identity`** — still `200` in every state, no secret, no side effect (3.7).
- **Data routes** — `/api/workouts` and `/api/sessions` keep their `200`/`400`/`401`/`503`
  taxonomy (3.10).
- **Local-only app** — timer, builder, history, sounds all still work from browser storage; `User`,
  `Workout`, `WorkoutSession` keep exactly their current shape (3.11).
- **The pairing scheme** — alphabet, grouping, TTL, digest-only storage, device and live-code caps,
  two-way merge, rotation semantics: untouched (3.12).
- **Zero new environment variables** (3.9).

**Scope:**

All inputs where `isBugCondition` is false are completely unaffected. Concretely, that is every
request on the three states above. The only permitted deviation is the one `bugfix.md` already
exempts: `/api/health` gains additive readiness fields while its status and its independence from
the database are preserved.

The actual expected correct behaviour under the bug condition is defined in
[Correctness Properties](#correctness-properties).

## Hypothesized Root Cause

The pairing migration is committed, additive (four `CREATE TABLE`s, one `CREATE TYPE`, indexes,
foreign keys — no `ALTER` to existing tables), and `railway.json` declares
`preDeployCommand: "npm run migrate:deploy"`. The tables are nevertheless absent. Railway's
Pre-deploy log was not readable during analysis, so four causes remain live. Each produces the same
externally visible symptom, and the fix must be robust across all four.

1. **P3005 — non-empty database with no migration history.** The Postgres instance already held the
   `20250915000000_init` objects (created by an earlier `db push`, a restored dump, or a build that
   ran `prisma db push`) before `_prisma_migrations` existed. `prisma migrate deploy` then refuses
   the *whole* directory with P3005 and applies nothing — including the additive pairing migration.
   Remedy: baseline the init migration with `prisma migrate resolve --applied 20250915000000_init`,
   then deploy. **This is the leading hypothesis**, because it explains why an app whose `User` and
   `Workout` tables plainly work is missing only the newer migration's tables.

2. **The Prisma CLI is absent at pre-deploy time.** `prisma` (the CLI) is a **devDependency**;
   `@prisma/client` is a dependency. Pre-deploy runs after the build, in the runtime image, where a
   production install prunes devDependencies — `npm run migrate:deploy` would then fail with
   `prisma: not found` (exit 127) rather than with a Prisma error code. This is the cause most
   likely to be mistaken for cause 3, because the failure text mentions no migration at all.
   Remedy: move `prisma` to `dependencies`, and make the wrapper resolve the CLI explicitly and
   fail with a named error if it cannot.

3. **`railway.json`'s `preDeployCommand` is not honoured.** Service settings configured in the
   Railway dashboard take precedence over the committed file, and a mismatched config path or
   service root means the file is never read. In this case *no* pre-deploy step runs at all.
   **No pre-deploy script can detect this** — the detector has to live in the running app, which is
   exactly what movements 2–4 of this design provide. The wrapper prints an unmistakable banner so
   an operator can confirm from the log whether it ran at all.

4. **A partially applied migration.** `_prisma_migrations` holds a row for the pairing migration
   with `finished_at` NULL (interrupted mid-apply). `migrate deploy` then fails with P3009 and
   refuses to proceed until the failed migration is resolved. Some pairing objects may exist and
   others not, so this is the one case where re-running the SQL is *not* safe, and the wrapper must
   refuse to guess.

Cause 1 and 4 are mutually exclusive (P3005 means no history exists; P3009 means history exists).
Causes 2 and 3 are indistinguishable from each other in the app but distinguishable in the log by
the presence of the wrapper's banner.

## Correctness Properties

Property 1: Bug Condition — a classified deployment fault, not a crash

_For any_ pairing request where the bug condition holds (`isBugCondition` returns true), the fixed
pairing routes SHALL answer `503` with `reason: 'schema-not-migrated'`, and the response body SHALL
contain no pairing code, no device token and no connection string.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Bug Condition — the failure is self-reporting

_For any_ pairing request where the bug condition holds, the fixed system SHALL emit exactly one
server-side diagnostic naming the route, the Prisma error code and the operator remedy, and that
diagnostic SHALL contain no pairing code, device token, connection string or IP address (nor the
`ipHash` derived from one); `GET /api/pair/identity` SHALL report `syncAvailable: false` with
`reason: 'schema-not-migrated'` at status `200`; and `GET /api/health` SHALL answer `200` with
`pairingSchemaReady: false`.

**Validates: Requirements 2.4, 2.7, 2.8**

Property 3: Bug Condition — the user is told the truth

_For any_ pairing failure where the bug condition holds, the message the Sync panel renders SHALL
differ from both the not-configured copy and the unreachable copy, and SHALL state that the server
is not ready, that this is not the user's fault, and that local data is safe.

**Validates: Requirements 2.5, 2.6**

Property 4: Preservation — the three non-buggy states do not move

_For any_ input where the bug condition does NOT hold (no database configured; configured but
unreachable; healthy and fully migrated), the fixed routes, the fixed client and the fixed Sync
panel SHALL produce the same result as the original — the same status, the same body and the same
copy — preserving the entire status taxonomy, the pairing scheme, the rate limiter and the
local-only experience. `GET /api/health` is exempt from byte-equality only in that it gains
additive readiness fields; its status and its independence from the database are preserved.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12**

## Fix Implementation

### Decision 1: `503` with a new reason, not `500` with a code

The status code serves the *client*, and `pairingClient.ts` already treats `503` as
retryable/not-your-fault/keep-local-data-safe — which is precisely the correct client behaviour for
a server that has not been migrated yet. Operator visibility is delivered by the new diagnostic
(2.4) and the new health fields (2.8), not by the status code.

The consequence is that `503` now covers three causes, so **`reason` becomes the sole
discriminator** and must be reliable and exhaustively enumerated. That is made structural:

**New file — `lib/data/syncUnavailableReason.ts`.** Imports nothing (the same discipline
`prismaFake.ts` follows), so it is safe in a server bundle, a client bundle and the test project
alike:

```ts
export const SYNC_UNAVAILABLE_REASONS = [
  'not-configured',      // no DATABASE_URL — a supported state (3.2)
  'unreachable',         // configured, cannot connect (3.3)
  'schema-not-migrated', // configured, reachable, relations absent — this bug (2.1)
] as const

export type SyncUnavailableReason = (typeof SYNC_UNAVAILABLE_REASONS)[number]

/** Total: any unrecognised wire value degrades to the retryable case. */
export function asSyncUnavailableReason(value: unknown): SyncUnavailableReason
```

`apiResponses.ts` (server) and `pairingClient.ts` (client) both import this union, so a reason added
on one side without the other is a type error rather than a silent mismatch. Every consumer that
branches on it does so with an exhaustive `switch` whose `default` narrows to `never`, so a fourth
reason cannot be added without every branch being revisited.

### 1. The functional fix: make the migration apply, robustly (requirement 2.9)

**New file — `scripts/predeploy-migrate.mjs`** (plain Node ESM, zero dependencies, no build step —
`scripts/generate-pwa-icons.mjs` establishes the precedent).

```
BANNER "[predeploy] pairing-schema migration guard"       // proves cause 3 either way

IF DATABASE_URL is unset OR blank THEN
  PRINT "[predeploy] no DATABASE_URL — local-only deployment, nothing to migrate"
  EXIT 0                                                  // preserves 3.2, 3.9
END IF

cli ← resolvePrismaCli()                                  // node_modules/prisma/build/index.js,
                                                          // else `npx --no-install prisma`
IF cli is null THEN
  FAIL "[predeploy] FATAL: the Prisma CLI is not installed in this image.
        Remedy: keep `prisma` in dependencies, not devDependencies."   // cause 2, named
END IF

result ← run(cli, ["migrate", "deploy"])                  // stdout+stderr echoed verbatim

IF result.failed AND result.output CONTAINS "P3005" THEN
  PRINT "[predeploy] P3005: database has tables but no migration history — baselining"
  run(cli, ["migrate", "resolve", "--applied", "20250915000000_init"])   // EXACTLY this one
  result ← run(cli, ["migrate", "deploy"])                // retried once, never twice
END IF

IF result.failed AND result.output CONTAINS "P3009" THEN
  FAIL "[predeploy] FATAL: a previous migration is recorded as failed. This is not safe to
        repair automatically. Remedy: inspect _prisma_migrations, then
        `prisma migrate resolve --rolled-back <name>` and redeploy."    // cause 4, refuses to guess
END IF

IF result.failed THEN FAIL with Prisma's own output END IF

status ← run(cli, ["migrate", "status"])                  // verification, read-only
IF status.failed THEN
  FAIL "[predeploy] FATAL: migrations are still pending after a successful deploy."
END IF

PRINT "[predeploy] OK: database schema is up to date"
EXIT 0
```

**`package.json`:** add `"predeploy": "node scripts/predeploy-migrate.mjs"`. `migrate:deploy`
remains **exactly** `prisma migrate deploy` — operators keep the plain command, and the existing
assertion pinning that string keeps passing verbatim. Move `prisma` from `devDependencies` to
`dependencies` (cause 2; no new environment variable, and `@prisma/client` is already a
dependency).

**`railway.json`:** `preDeployCommand` becomes `"npm run predeploy"`. This is the one existing
assertion in `deployment-config.test.ts` that must be rewritten rather than left alone — its intent
("the migration runs in the release phase and a failure aborts the deploy") is preserved and
strengthened; see [Testing Strategy](#testing-strategy).

**Why each step is safe to run on every deploy (idempotence):**

| Step | Already-migrated database | Fresh database | Bug-condition database |
|---|---|---|---|
| `migrate deploy` | no-op, exit 0 | applies both migrations | applies the pairing migration (after baseline, if P3005) |
| `migrate resolve --applied 20250915000000_init` | never reached (P3005 cannot recur once history exists) | never reached | runs once, writes one history row, creates no objects |
| `migrate status` | exit 0 | exit 0 | exit 0 only if nothing is pending |

**Why the baseline list is hard-coded to the init migration alone.** `migrate resolve --applied`
marks a migration as applied *without running its SQL*. Baselining
`20250917000000_device_pairing_sync` would permanently record the pairing tables as created while
leaving them absent — it would convert this bug into an unfixable one. The wrapper therefore names
exactly one migration, and a test asserts the pairing migration's name never appears next to
`--applied`.

**Why the failure becomes loud.** Every failure path exits non-zero, so Railway's pre-deploy step
fails and the release is aborted instead of serving an incomplete schema (defect 1.9). `migrate
status` closes the gap where `migrate deploy` succeeds but leaves work pending. The banner makes
cause 3 diagnosable from the log: if the banner is absent from the Pre-deploy output, the command
is not being run, and the operator must set it in the service settings, which override
`railway.json`.

**Rejected alternative: migrate at server start.** It would race across replicas, and it would
either delay or block boot — which contradicts 3.8/3.11 (the timer must serve with no database at
all). Migration stays in the release phase; the app's job is to *report* an unmigrated schema, not
to repair one.

### 2. The classifier and the diagnostic (requirements 2.3, 2.4)

**`lib/data/apiResponses.ts`:**

```ts
/** Prisma "the schema is not what the client expects" codes. */
const SCHEMA_MISSING_PRISMA_CODES = new Set(['P2021', 'P2022'])

export function isSchemaNotMigrated(error: unknown): boolean
```

Matching order inside the predicate, most reliable first:

1. `error.code` ∈ `{P2021, P2022}` — the documented, stable field, and the only one the tests rely
   on for fidelity.
2. Postgres SQLSTATE surfaced through a raw/unknown error: `42P01` (undefined_table) or `42703`
   (undefined_column).
3. Message fallback only: `/relation ".*" does not exist|does not exist in the current database/i`
   — a convenience for wrappers that lose the code, never the primary signal.

`databaseUnavailable` widens its parameter to `SyncUnavailableReason` and gains the third message:
*"Sync isn't ready on this server yet. Your data stays in this browser and will sync once the
server is updated."*

`errorResponse` gains an optional context argument and a three-way ladder:

```ts
export function errorResponse(error: unknown, context?: { route: string }): NextResponse {
  if (isDatabaseUnreachable(error)) return databaseUnavailable('unreachable')   // unchanged, first
  if (isSchemaNotMigrated(error)) {
    noteSchemaFault()                                    // feeds the readiness cache
    logSchemaNotMigrated(error, context)                 // exactly one diagnostic
    return databaseUnavailable('schema-not-migrated')
  }
  return serverError()                                   // unchanged
}
```

**Connectivity is checked first, deliberately:** a database you cannot reach cannot tell you
whether a table exists, and the two code sets are disjoint (`P10xx` vs `P20xx`), so the ordering is
about determinism rather than overlap. `isDatabaseUnreachable` is not modified, which is what
preserves 3.3 exactly.

**The one-diagnostic-per-failure rule.** `errorResponse` is the single funnel every pairing route's
`catch` block already uses, and `logSchemaNotMigrated` is called from nowhere else. One failing
request therefore produces exactly one line. Specifically:

- The readiness probe (§4) **never** logs — it runs on every first page load, and logging there
  would flood.
- The generic `500` branch stays silent, as today (no new noise, no preservation risk).
- No throttling is needed: pairing requests are already capped at 10 CREATE/hour/IP and 60
  CLAIM/minute globally by the existing limiter, which bounds the log volume for free.

**The diagnostic's content is a fixed template plus allow-listed fields — never `error.message`,
never `error.stack`:**

```
[sync] schema-not-migrated route=/api/pair/code prismaCode=P2021 table=public.PairingAttempt remedy="run `prisma migrate deploy`; if it reports P3005, first `prisma migrate resolve --applied 20250915000000_init`"
```

Only three interpolations are permitted, each guarded by a `typeof === 'string'` check: the caller's
literal `route`, `error.code`, and `error.meta?.table ?? error.meta?.modelName`. Everything else is
a literal. It follows structurally — not by convention — that the line cannot contain a pairing
code, a device token, a connection string, an IP address or the `ipHash` derived from one: none of
those values is in scope at the call site, and `error.message` (the one field that could carry a
connection string, via `P1001`) is never read. `console.error` is the sink, because Railway
captures stdout/stderr and adding a logger would add a dependency.

**Call sites.** `app/api/pair/code/route.ts`, `claim`, `devices`, `devices/[id]` and `rotate` pass
`{ route: '/api/pair/...' }` to their existing `errorResponse(error)` calls. That is a one-argument
edit per route; no control flow moves. The data routes keep calling `errorResponse(error)` with no
context — they gain the schema classification (a `500` becomes a `503`, which is *inside* the
taxonomy 3.10 pins) and, having no `route` context, log with `route=unknown`.

### 3. The client and the panel (requirements 2.5, 2.6)

**`lib/data/pairingClient.ts`.** `PairingUnavailableError.reason` widens from a hand-written union
to `SyncUnavailableReason | 'offline'`. In the `503` branch, the hand-rolled ternary
(`=== 'not-configured' ? … : 'unreachable'`) is replaced by `asSyncUnavailableReason(body?.reason)`.
The `>= 500` fallback below it is untouched, so every other `5xx` keeps folding into
`'unreachable'` — the second half of 2.5, and the reason the `429`/`503`/`409`/`400` ladder above it
does not move.

**`lib/data/repositoryClient.ts`.** The probe already reads `syncAvailable`; it now also records the
reason. The existing surface is deliberately **not** changed — `getSyncAvailability()` still returns
`boolean | null` and `subscribeSyncAvailability` still takes `(available: boolean) => void`, because
`sync-settings.test.tsx` mocks both. One additive export:

```ts
export function getSyncUnavailableReason(): SyncUnavailableReason | null
```

**Ordering is load-bearing:** the reason is assigned *before* `setSyncAvailability(false)` notifies
listeners, so any component re-rendered by that notification already reads the correct reason.
`resetForTests()` clears it alongside the other module state.

**`app/_components/sync-settings.tsx`.** Two changes, one new constant:

```ts
const SERVER_NOT_READY_COPY =
  "Sync isn't ready on this server yet — that's on us, not something you did. Your workouts and " +
  'history are safe on this device. Try again in a few minutes.'
```

It states all three things 2.6 demands (server not ready; not the user's fault; local data safe) and
reuses neither `UNAVAILABLE_COPY` (*"Sync isn't set up on this server"* — reserved for a deployment
with no database) nor the unreachable line.

1. `messageFor` replaces the two-branch ternary inside the `PairingUnavailableError` case with an
   exhaustive `switch` over `'offline' | 'not-configured' | 'unreachable' | 'schema-not-migrated'`,
   whose `default` narrows to `never`. `offline`, `not-configured` and `unreachable` keep their
   exact current strings (preservation); `schema-not-migrated` returns the new copy.
2. The whole-panel `available === false` branch — reached via the identity probe, which is how a
   real user meets this bug — reads `getSyncUnavailableReason()` and renders `SERVER_NOT_READY_COPY`
   under `data-testid="sync-server-not-ready"` for `'schema-not-migrated'`, and otherwise the
   unchanged `UNAVAILABLE_COPY` under the existing `data-testid="sync-unavailable"`. A `null` reason
   (nothing recorded) takes the existing path, which is what keeps the current test green.

### 4. The probes (requirements 2.7, 2.8)

**New file — `lib/pairing/schemaReadiness.ts`.** Takes its database as a structural slice
(`SchemaProbeDb`), exactly as `RateLimitDb` and `IdentityDb` do, so it imports neither `@/lib/db`
nor `@prisma/client`, cannot construct a client at import time, and accepts the in-memory fake with
no cast.

```ts
export type SchemaReadiness = 'ready' | 'not-migrated' | 'unreachable' | 'unknown'

export const READY_TTL_MS = 10 * 60 * 1000   // a migrated schema does not un-migrate
export const FAULT_TTL_MS = 30 * 1000        // but a broken one gets fixed without a redeploy

export async function pairingSchemaReadiness(db: SchemaProbeDb): Promise<SchemaReadiness>
export function peekPairingSchemaReadiness(): SchemaReadiness   // pure, no I/O
export function noteSchemaFault(): void                          // called from errorResponse
export function resetSchemaReadinessCache(): void                // test seam, mirrors resetSweepGuard
```

**The probe query** is `db.pairingAttempt.findFirst({ select: { id: true } })` — read-only,
returns at most one row, no write, so the identity route stays side-effect-free (3.7). Three reasons
for that table and that query:

- `PairingAttempt` is the *first* relation every pairing write path touches (the limiter's ledger
  read), so the probe's verdict and the real path's fate coincide — the probe cannot say "ready"
  about a path that will fail at step one.
- A `$queryRaw` interrogation of `information_schema` would check all four relations, but
  `prismaFake` cannot answer raw SQL, and requirement 2.10 forbids depending on a live Postgres.
  **Testability is the deciding factor here**, and the trade is explicit: the probe is a *readiness
  signal*, not a schema verifier. Per-request authority stays with the classifier, which sees
  whichever relation actually failed.
- `migrate deploy` applies each migration's SQL in a transaction, so the four relations appear
  together; a split is only possible under root cause 4, which the pre-deploy wrapper refuses to
  paper over.

**Caching — the asymmetric TTL.** A `'ready'` verdict is cached for 10 minutes; a `'not-migrated'`
or `'unreachable'` verdict for 30 seconds. This is the answer to the cache-invalidation risk: an
operator who applies the migration *without redeploying* sees the identity probe and the health
field recover within 30 seconds, so a permanently-cached "not ready" — a new bug in its own right —
cannot happen. The asymmetry is justified by asymmetric cost: a stale `ready` is corrected by the
next real request's classifier, whereas a stale fault would be a self-inflicted outage of a working
feature. `'unknown'` is never cached; it is the value `peek` returns before any probe has run.

**Bounded cost (2.7).** At most one extra query per TTL per process: ≤1 per 10 minutes when
healthy, ≤1 per 30 seconds when broken. That is bounded and independent of request volume, so no
unbounded per-request database cost is added.

**Concurrent first-probes.** The in-flight promise is memoised (`let inflight: Promise<…> | null`),
the same pattern `repositoryClient`'s `sessionProbe` uses: N concurrent probes issue **one** query
and share its answer, and `inflight` is cleared in a `finally` so a rejection cannot poison the
slot. A thrown error is classified in place — `isSchemaNotMigrated` → `'not-migrated'`,
`isDatabaseUnreachable` → `'unreachable'`, anything else → `'unreachable'` (fail safe: an
unclassifiable probe failure must not be reported as ready).

**`app/api/pair/identity/route.ts`** — one branch changes:

```ts
if (identity.kind === 'anonymous') {
  const readiness = await pairingSchemaReadiness(db)
  if (readiness === 'not-migrated') return NextResponse.json({ ...localOnly, reason: 'schema-not-migrated' })
  if (readiness === 'unreachable')  return NextResponse.json({ ...localOnly, reason: 'unreachable' })
  return NextResponse.json({ ...localOnly, syncAvailable: true })
}
```

The `!getPrismaClient()`, `database-error` and authenticated branches are untouched, so 3.7 and the
existing identity assertions hold. Note the minimisation: a *paired* caller's cookie lookup already
proved the schema exists, so no extra query is issued on that path; the probe runs only on the
`anonymous` branch, which is precisely the branch that today wrongly answers `syncAvailable: true`
(defect 1.7). Still `200`, still no secret, still no side effect.

**`app/api/health/route.ts`** — additive only, and it still never touches the database:

```ts
const pairingSchema = peekPairingSchemaReadiness()   // pure cache read, no I/O, no getPrismaClient()
…
pairingSchema,                                 // 'ready' | 'not-migrated' | 'unreachable' | 'unknown'
pairingSchemaReady: pairingSchema === 'ready', // the boolean an alert should rule on
```

`status`, `database`, `accounts`, `mode` and `timestamp` keep their exact current values and
derivations.

**The risk, called out explicitly.** Railway uses `/api/health` as its healthcheck
(`railway.json` → `healthcheckPath`). Making health fail — or gating it on the database — would
take a perfectly working timer out of rotation on a database hiccup, which is the opposite of what
this app wants (12.10, 12.11, 3.8). So health is **passive**: it reads the cache and never issues a
query, never calls `getPrismaClient()`, and never awaits anything. `app/api/data-routes.test.ts`
asserts `getPrismaClient` is not called by this route, and that assertion is left untouched as the
structural guard on this decision.

The consequence, stated honestly: in a cold process nothing has probed yet, so the field reports
`'unknown'` / `pairingSchemaReady: false`. That is truthful and it fails safe — the boolean is never
`true` unless readiness has actually been proven — and it satisfies 2.8, because a green health
response can no longer *claim* pairing readiness it has not verified. In practice the cache is
populated within seconds of the first visitor, because every browser hits `/api/pair/identity` on
first load, and every failing pairing request feeds `noteSchemaFault()` through the classifier.

### File-by-file summary

| File | Change | Requirements |
|---|---|---|
| `scripts/predeploy-migrate.mjs` | **new** — migration guard: P3005 baseline, verify, fail loud | 2.9 |
| `package.json` | add `predeploy` script; move `prisma` to `dependencies`; `migrate:deploy` untouched | 2.9, 3.9 |
| `railway.json` | `preDeployCommand` → `npm run predeploy` | 2.9 |
| `lib/data/syncUnavailableReason.ts` | **new** — the shared closed union + total parser | 2.1, 2.5 |
| `lib/data/apiResponses.ts` | `isSchemaNotMigrated`, third `databaseUnavailable` reason, `errorResponse` ladder + the single diagnostic | 2.1–2.4 |
| `lib/pairing/schemaReadiness.ts` | **new** — cached, deduplicated readiness probe | 2.7, 2.8 |
| `app/api/pair/{code,claim,devices,devices/[id],rotate}/route.ts` | pass `{ route }` to `errorResponse` | 2.1, 2.2, 2.4 |
| `app/api/pair/identity/route.ts` | readiness check on the `anonymous` branch | 2.7 |
| `app/api/health/route.ts` | additive `pairingSchema` + `pairingSchemaReady` from the cache | 2.8 |
| `lib/data/pairingClient.ts` | reason parsed through the shared union; other `5xx` unchanged | 2.5 |
| `lib/data/repositoryClient.ts` | additive `getSyncUnavailableReason()` | 2.6 |
| `app/_components/sync-settings.tsx` | new copy + exhaustive `switch`; panel branch reads the reason | 2.6 |
| `lib/pairing/__fixtures__/prismaFake.ts` | additive `missingRelations` option raising P2021 | 2.10 |

## Testing Strategy

### Toolchain (read this before running anything)

**The suite passes only under Node 22:**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22
# or: export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
npm test
```

Under the Node 20 pinned by `.nvmrc` and `engines`, 29 of 34 files fail to collect with
`TypeError: webidl.util.markAsUncloneable is not a function`, thrown from the undici bundled inside
jsdom. **This is pre-existing and out of scope for this fix — do not attempt to fix it — and it
must not be misread as a regression.** Verified baseline on this branch under Node 22:
**34 files / 519 tests passing**.

The production build must be verified the way Railway installs, with devDependencies effectively
absent:

```bash
mv node_modules/@vitejs /tmp/_v; env -u DATABASE_URL npm run build; mv /tmp/_v node_modules/@vitejs
```

`npm run typecheck` covers both TypeScript projects (`tsc --noEmit` and
`tsc -p tsconfig.test.json --noEmit`); `syncUnavailableReason.ts` and `schemaReadiness.ts` must
typecheck under both, which is why neither imports a devDependency.

### Validation Approach

Two phases. First surface counterexamples that demonstrate the bug on unfixed code and record the
exact behaviour of the three non-buggy states; then verify the fix under the bug condition and prove
the recorded behaviour did not move.

### The fake must represent a missing relation faithfully

There is no live Postgres in the sandbox or in CI, so `lib/pairing/__fixtures__/prismaFake.ts` is
the only way to reach the bug condition. **If the fake is not faithful here, every test below is
worthless.** Additive change:

```ts
export type FakeRelationName =
  | 'SyncSpace' | 'PairingCode' | 'PairedDevice' | 'PairingAttempt'
  | 'User' | 'Workout' | 'WorkoutSession'

export interface PrismaFakeOptions {
  now?: () => number
  seed?: Partial<FakeStore>
  /** Relations that do not exist in the database: every delegate call raises P2021. */
  missingRelations?: readonly FakeRelationName[]
}

/** The bug condition, ready-made: configured, reachable, all four pairing relations absent. */
export function missingPairingSchema(options?: PrismaFakeOptions): PrismaFake
```

Fidelity rules, each mirroring real Prisma:

- The thrown value is a `FakePrismaError` with `name === 'PrismaClientKnownRequestError'`,
  `code === 'P2021'`, `meta.table === 'public.<Relation>'`, and the message *"The table
  `public.<Relation>` does not exist in the current database."* `FakePrismaError` is extended to
  carry `meta.table` / `meta.modelName` alongside its existing `meta.target`, so the classifier and
  the diagnostic are exercised against the same fields production supplies.
- **Every** delegate method throws — `findUnique`, `findFirst`, `findMany`, `count`, `create`,
  `update`, `updateMany`, `upsert`, `delete`, `deleteMany` — and so does a call made inside
  `$transaction`, because in production the failure lands on whichever touch comes first.
- The throw happens *before* any `where` evaluation, so a missing relation cannot accidentally
  behave like an empty one — the failure mode that would make Property 1 pass against unfixed code.
- The classifier must key on `code` first and treat the message regex as a fallback only, so test
  fidelity rests on the field Prisma documents as stable. One unit test records the assumed shape
  explicitly, so a future Prisma upgrade that changes it fails visibly here rather than silently in
  production.

### Exploratory Bug Condition Checking

**Goal**: surface counterexamples that demonstrate the bug BEFORE implementing the fix, and
confirm or refute the root-cause analysis. If refuted, re-hypothesize.

**Test Plan**: add `missingRelations` to the fake, point the existing `vi.mock('@/lib/db', …)`
harness in `app/api/pair/pair-routes.test.ts` at `missingPairingSchema()`, and observe the unfixed
routes. Run before any production code changes.

**Test Cases**:
1. **Create-code fault**: `POST /api/pair/code` against `missingPairingSchema()` — expect the
   observed `500 {"error":"Unexpected server error"}` (will fail once fixed to `503`).
2. **Claim fault**: `POST /api/pair/claim` — expect the same `500` at the same ledger read, with
   nothing about the submitted code in the body.
3. **Silent failure**: spy on `console.error` — expect **zero** calls, demonstrating defect 1.4.
4. **Lying probes**: `GET /api/pair/identity` — expect `syncAvailable: true`;
   `GET /api/health` — expect `mode: 'sync-capable'` with no readiness field.
5. **Misattributed copy**: drive `messageFor` with `PairingUnavailableError('…','unreachable',503)`
   — expect *"Sync is unavailable right now…"*, demonstrating defect 1.6.
6. **Edge case — which relation fails first**: `missingRelations: ['PairingAttempt']` alone must
   reproduce the `500`, confirming the limiter's ledger read is the first touch and that fixing
   only the pairing tables' *own* handlers would not have been enough.

**Expected Counterexamples**: a `P2021` escaping `isDatabaseUnreachable` into `serverError()`; no
log line; both probes reporting availability. These confirm the *application-level* root cause
exactly. They cannot discriminate among the four *deployment-level* causes — that needs the Railway
Pre-deploy log, which is why the wrapper is built to be robust across all four and to print a
banner that identifies cause 3 by its absence.

### Fix Checking

**Goal**: verify that for all inputs where the bug condition holds, the fixed functions produce the
expected behaviour.

```
FOR ALL X WHERE isBugCondition(X) DO
  result := handlePairing_fixed(X)
  ASSERT result.status = 503
     AND result.body.reason = 'schema-not-migrated'
     AND result.body CONTAINS NO code, token OR connection_string      // Property 1
  ASSERT diagnostics_emitted(X) = 1
     AND names_route_code_and_remedy(diagnostics_emitted(X))
     AND probeIdentity_fixed(X).syncAvailable = FALSE
     AND probeHealth_fixed(X).pairingSchemaReady = FALSE
     AND probeHealth_fixed(X).status = 200                             // Property 2
  ASSERT syncPanelMessage_fixed(X) ∉ { notConfiguredCopy, unreachableCopy }
     AND syncPanelMessage_fixed(X) STATES server_not_ready ∧ local_data_safe   // Property 3
END FOR
```

### Preservation Checking

**Goal**: verify that for all inputs where the bug condition does NOT hold, the fixed functions
produce the same result as the original.

```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT handlePairing_original(X)   = handlePairing_fixed(X)
     AND probeIdentity_original(X)   = probeIdentity_fixed(X)
     AND syncPanelMessage_original(X) = syncPanelMessage_fixed(X)
END FOR
```

**Testing approach.** Property-based testing is right for preservation because it generates many
cases across the input domain automatically and catches edge cases hand-written tests miss. One
honest limitation: the unfixed function `F` is not available at runtime once the fix lands, so
`handlePairing_original` is represented by expectations **recorded during the exploratory phase**
from the three non-buggy states, plus the 519 existing tests, which already pin that behaviour in
detail. The existing suite is the primary preservation oracle; the recorded table covers what it
does not assert explicitly.

**Test Plan**: observe the three non-buggy states on unfixed code first — absent client
(`absentDatabaseModule()`), unreachable client (the existing `unreachableDatabase()` helper), and
healthy client (`createPrismaFake()`) — then assert the same status and body after the fix.

**Test Cases**:
1. **No database**: every pairing route still `503 {reason:'not-configured'}`; identity still the
   exact local-only body; the panel still renders `sync-unavailable` with `UNAVAILABLE_COPY` (3.2).
2. **Unreachable database**: still `503 {reason:'unreachable'}`; identity still
   `{...localOnly, reason:'unreachable'}`; the client still classifies it retryable (3.3).
3. **Healthy database**: `POST /api/pair/code` still `201`, code emitted once, digest-only storage,
   TTL from the constant, device enrolled, cookie set (3.4); claim rejections still one uniform
   `400` (3.5); the limiter's caps, ordering, `Retry-After` and one-row-per-attempt unchanged (3.6).
4. **Health**: still `200`; `status`/`database`/`accounts`/`mode` byte-identical; `getPrismaClient`
   still not called (3.8) — the existing assertion is left untouched as the guard.
5. **Data routes**: `/api/workouts` and `/api/sessions` still `200`/`400`/`401`/`503` (3.10).
6. **Zero configuration**: no new environment variable is read anywhere in the diff (3.9).
7. **Suite-wide**: 34 files / 519 tests still green, clean typecheck, successful devDependency-free
   build (3.1). New tests are additive; the *only* existing assertion that may be rewritten is
   `deployment-config.test.ts`'s *"runs the migration in the release phase"*, whose subject this fix
   intentionally changes. Its `it` count stays 21 and its intent is preserved and strengthened.

### Unit Tests

- `isSchemaNotMigrated`: `P2021`/`P2022` true; `P2002`/`P2025` false; every `P10xx` in the
  unreachable set false; SQLSTATE `42P01`/`42703` true; `null`/`undefined`/`{}`/a plain `Error`
  false.
- `errorResponse` ladder: connectivity wins over schema; schema wins over generic; the generic
  branch still `500` and still silent.
- The diagnostic: exactly one `console.error` per failing request; the line contains the route, the
  Prisma code and a remedy; it contains none of a seeded pairing code, a seeded `bx_device` token,
  a `postgres://…` URL, a literal IP, or the `ipHash` derived from `x-forwarded-for`.
- `asSyncUnavailableReason`: total — every member round-trips, and `undefined`/`''`/`'nonsense'`/`42`
  all degrade to `'unreachable'`.
- `schemaReadiness`: `'ready'` on a healthy fake; `'not-migrated'` on `missingPairingSchema()`;
  `'unreachable'` on the unreachable fake; `'unreachable'` (never `'ready'`) on an unclassifiable
  throw; `peek()` returns `'unknown'` before any probe.
- Cache behaviour: a second call inside the TTL issues no query (spy on the delegate); a fault
  verdict is re-probed after `FAULT_TTL_MS` with `vi.setSystemTime` and reports `'ready'` once the
  fake is repaired — the operator-migrated-without-redeploying case; a `'ready'` verdict is held for
  `READY_TTL_MS`.
- Concurrency: `await Promise.all([...5 probes])` issues exactly **one** underlying query and all
  five resolve to the same verdict; a rejected in-flight probe leaves the slot re-probeable.
- Identity route: `200` + `syncAvailable: false` + `reason: 'schema-not-migrated'` under the bug
  condition; a paired caller under a healthy fake triggers **no** readiness query.
- Health route: `200`; `pairingSchema`/`pairingSchemaReady` reflect the cache; `getPrismaClient`
  never called; the other fields unchanged.
- `pairingClient`: `503` + `schema-not-migrated` → `PairingUnavailableError` with that reason;
  `503` with an unknown reason → `'unreachable'`; `500`/`502`/`504` → `'unreachable'`; the
  `429`/`409`/`400` ladder unchanged.
- `sync-settings`: `messageFor` returns the new copy for `'schema-not-migrated'` and the exact
  current strings for the other three; the panel renders `sync-server-not-ready` when the recorded
  reason is `'schema-not-migrated'` and the unchanged `sync-unavailable` otherwise; the new copy
  contains neither `UNAVAILABLE_COPY` nor the unreachable line.
- `deployment-config`: `predeploy` exists and is wired into `railway.json`; the wrapper invokes
  `migrate deploy` and verifies with `migrate status`; it baselines `20250915000000_init` and
  **never** names `20250917000000_device_pairing_sync` next to `--applied`; `migrate:deploy` is
  still exactly `prisma migrate deploy`; `prisma` is in `dependencies`; the healthcheck path and
  `$PORT` binding are unchanged.

### Property-Based Tests

Using `fast-check`, already a devDependency:

1. **The classifier partitions its input space.** For any generated Prisma-shaped error, exactly one
   of the three branches fires: `code ∈ P10xx-set` → `503 unreachable`; `code ∈ {P2021,P2022}` →
   `503 schema-not-migrated`; any other code → `500`. Total, disjoint, no fallthrough.
2. **Redaction holds for every input.** For arbitrary pairing codes, device tokens, IP addresses and
   connection strings injected into the request and the fake's store, the captured diagnostic
   contains none of them, and the `503` body contains none of them either (Properties 1, 2).
3. **The reason union never widens on the wire.** For any `503` body the client can receive, the
   parsed reason is a member of `SYNC_UNAVAILABLE_REASONS` (Property 1's discriminator reliability).
4. **Preservation across non-buggy states.** For arbitrary pairing requests crossed with the three
   non-buggy database states, the response status and body equal the recorded pre-fix expectations
   (Property 4).
5. **Cache cost is bounded.** For any generated sequence of probe timestamps, the number of
   underlying queries is at most `⌈span / TTL⌉ + 1` — the formal statement of "no unbounded
   per-request database cost" (2.7).

### Integration Tests

- **Full create-code flow under the bug condition**: request → limiter's first ledger read throws
  `P2021` → `503 schema-not-migrated` → client raises `PairingUnavailableError{'schema-not-migrated'}`
  → panel renders the new copy. One diagnostic for the whole flow.
- **Recovery without a redeploy**: bug condition → `503` and `pairingSchemaReady: false`; repair the
  fake; advance the clock past `FAULT_TTL_MS`; the identity probe reports `syncAvailable: true`,
  health reports `ready`, and `POST /api/pair/code` answers `201` — no process restart involved.
- **State transitions**: absent → unreachable → not-migrated → ready, asserting the panel's copy and
  the health fields at each step, and that the three pre-existing states' copy never changes.
- **Deploy-path smoke test**: run `node scripts/predeploy-migrate.mjs` with `DATABASE_URL` unset and
  assert exit 0 with the "nothing to migrate" line (the local-only deployment path, 3.2). The
  P3005/P3009 branches are asserted through the script's static content and a stubbed runner, since
  no Postgres is available.

## Deliberate Omissions

- **The generic `500` branch stays silent.** Adding a diagnostic there is tempting, but 2.4 scopes
  the requirement to schema faults, and after this fix the remaining `500`s are genuinely unknown
  faults with no remedy to print. Out of scope.
- **Health does not probe.** Warming the cache from the healthcheck would populate `pairingSchema`
  sooner, but it would mean `/api/health` touching the database — breaking the existing
  "no `getPrismaClient` call" assertion and eroding 3.8/12.11 for a few seconds of freshness. The
  identity probe already warms it on first page load.
- **The readiness probe checks one relation, not four.** See §4; the classifier is the per-request
  authority.
- **The Node 20 jsdom collection failure is not addressed.** Pre-existing, unrelated, explicitly out
  of scope.
