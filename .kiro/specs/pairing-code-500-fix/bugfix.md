# Bugfix Requirements Document

## Introduction

On the deployed app, every pairing action fails. `POST /api/pair/code` answers
`500 {"error":"Unexpected server error"}` while `GET /api/health` reports the database as
`configured` / `sync-capable` and `GET /api/pair/identity` reports `syncAvailable: true`. The
Sync panel renders normally and then shows *"Sync is unavailable right now. Your data stays on
this device."* under both the generate-a-code button and the enter-a-code field.

The account-free sync feature is therefore completely unusable in production, and every signal
the deployment offers about *why* is either silent or actively wrong. The reported symptom is
one bug with three separable faults:

1. **The functional fault.** The pairing tables (`SyncSpace`, `PairingCode`, `PairedDevice`,
   `PairingAttempt`) are absent at runtime even though the migration that creates them is
   committed and `railway.json` runs `prisma migrate deploy` as its pre-deploy command. The
   first database touch on the create-code path is the rate limiter's ledger read, so the
   request throws before any pairing logic runs. The most likely cause is `migrate deploy`
   failing with **P3005** (non-empty database with no migration history) without failing the
   deploy loudly; a skipped pre-deploy step or a partially applied migration produce the same
   externally visible symptom. The fix must be robust across all three and must make the *next*
   occurrence self-reporting.

2. **The classification fault (diagnosability).** The shared error classifier maps only
   connectivity codes (`P1000`–`P1017`) to `503`. Prisma's **P2021** ("table does not exist")
   and **P2022** ("column does not exist") fall through to the generic `500` with no reason
   code and no server-side record. A missing table is a deployment fault with a known remedy,
   not an unknown crash, and it is currently indistinguishable from one.

3. **The attribution fault (user-facing).** The pairing client folds every `5xx` into
   `PairingUnavailableError` with reason `unreachable`, and the Sync panel renders that as copy
   whose meaning is "this deployment has no database". The user reasonably read that as a
   database-connection problem and reported it as one. Distinct states — not configured,
   unreachable, server-not-ready, rate-limited — need distinguishable messaging.

**Out of scope.** The pairing scheme itself is not being redesigned; `.kiro/specs/device-pairing-sync/`
remains the authority on intended behaviour. The previously reported audio problem was user
error (a physical mute switch) and is not part of this spec.

## Bug Analysis

### Current Behavior (Defect)

What happens today on a deployment where the database is configured and reachable but the
pairing schema is missing.

1.1 WHEN `POST /api/pair/code` is called THEN the system throws on its first ledger read and
responds `500 {"error":"Unexpected server error"}`, so no pairing code can ever be minted.

1.2 WHEN `POST /api/pair/claim` is called THEN the system fails identically at the same ledger
read and responds `500`, so a code from another device cannot be claimed either.

1.3 WHEN a Prisma error carrying `P2021` or `P2022` reaches the shared error classifier THEN the
system treats it as an unknown server fault and responds `500` with no machine-readable reason,
rather than reporting a schema/deployment fault.

1.4 WHEN a pairing route responds `500` THEN the system records nothing an operator can read —
no route, no error code, no remedy — so the underlying cause is invisible from outside and from
the logs alike.

1.5 WHEN the pairing client receives any `5xx` THEN it raises `PairingUnavailableError` with
reason `unreachable`, making a broken deployment indistinguishable from a genuinely unreachable
database.

1.6 WHEN the Sync panel handles that error THEN it displays "Sync is unavailable right now. Your
data stays on this device." — copy that asserts sync is not set up on this server, which
misattributes a server fault to deployment configuration and gives the user no accurate action.

1.7 WHEN `GET /api/pair/identity` is called THEN the system answers `syncAvailable: true`
because it only checks that a Prisma client exists, falsely reporting a capability that cannot
work.

1.8 WHEN `GET /api/health` is called THEN the system reports `database: "configured"` and
`mode: "sync-capable"` from the presence of `DATABASE_URL` alone, so an operator polling health
sees a green deployment whose pairing feature is entirely broken.

1.9 WHEN `prisma migrate deploy` fails during pre-deploy THEN the deployment continues to serve
traffic with an incomplete schema and no signal distinguishes it from a fully migrated one.

1.10 WHEN the test suite runs THEN no test exercises the missing-pairing-table path, so this
class of failure passes CI undetected and can only be found by manually probing production.

### Expected Behavior (Correct)

One clause per defect above, in the same order.

2.1 WHEN `POST /api/pair/code` is called and the pairing schema is missing THEN the system SHALL
respond `503` carrying a machine-readable reason that identifies the schema as not migrated,
distinct from both `not-configured` and `unreachable`, instead of `500`.

2.2 WHEN `POST /api/pair/claim` is called and the pairing schema is missing THEN the system
SHALL respond `503` with that same reason, and SHALL NOT reveal anything about any code.

2.3 WHEN a Prisma error carrying `P2021` or `P2022` (or an equivalent "relation does not exist"
failure) reaches the shared error classifier THEN the system SHALL classify it as a
schema-not-migrated fault distinct from both an unreachable database and an unknown server
error.

2.4 WHEN a pairing route fails because of a schema-not-migrated fault THEN the system SHALL
emit exactly one server-side diagnostic naming the route, the error code and the operator
remedy, and that diagnostic SHALL NOT contain a pairing code, a device token, a connection
string or an IP address.

2.5 WHEN the pairing client receives a `503` carrying the schema-not-migrated reason THEN it
SHALL surface that reason distinctly, and SHALL keep folding every other `5xx` into the
existing retryable-unavailable case.

2.6 WHEN the Sync panel handles a schema-not-migrated failure THEN it SHALL display copy that
states the server is not ready for sync, that this is not the user's fault and that local data
is safe, and SHALL NOT reuse the "sync isn't set up on this server" wording reserved for a
deployment with no database.

2.7 WHEN `GET /api/pair/identity` is called and the pairing schema is missing THEN the system
SHALL report sync as unavailable with a reason distinguishing "server not ready" from "not
configured", SHALL still answer `200`, SHALL remain free of side effects, and SHALL NOT add an
unbounded per-request database cost to the probe.

2.8 WHEN `GET /api/health` is called THEN the system SHALL report pairing-schema readiness as a
field distinct from `DATABASE_URL` presence, so a green health response cannot coexist with a
broken pairing feature.

2.9 WHEN the app is deployed THEN pending migrations SHALL be applied before traffic is served,
the deployment SHALL tolerate a database that already holds tables but no migration history,
and a migration step that cannot complete SHALL fail visibly rather than silently leaving an
incomplete schema.

2.10 WHEN the test suite runs THEN it SHALL include regression tests that simulate the missing
pairing tables using the existing in-memory fake and assert the `503` and its reason, the
single diagnostic, the client's distinct error and the panel's copy — all without a live
Postgres.

### Unchanged Behavior (Regression Prevention)

Everything below passes today and must be untouched by the fix.

3.1 WHEN the suite, the typechecker and the production build run THEN they SHALL CONTINUE to
report 519 passing tests across 34 files, a clean typecheck and a successful build.

3.2 WHEN `DATABASE_URL` is unset THEN every pairing route SHALL CONTINUE to answer `503` with
reason `not-configured` and the Sync panel SHALL CONTINUE to render its single muted
local-only explanation in place of every pairing control.

3.3 WHEN the database is configured but unreachable THEN the routes SHALL CONTINUE to answer
`503` with reason `unreachable` and the client SHALL CONTINUE to treat it as retryable.

3.4 WHEN the pairing schema is present and the database is healthy THEN `POST /api/pair/code`
SHALL CONTINUE to answer `201`, emit the plaintext code exactly once, persist only its SHA-256
digest, take its TTL from `PAIRING_CODE_TTL_MS` alone, enrol the calling device, and set the
device cookie for a previously anonymous caller.

3.5 WHEN a claim is rejected because the code is absent, expired, consumed or malformed THEN
the system SHALL CONTINUE to answer with one uniform `400` message, and the new
schema-not-migrated reason SHALL NOT become a new oracle about code state.

3.6 WHEN pairing requests are rate limited THEN the system SHALL CONTINUE to apply the existing
caps and windows, check the limit before any code processing, return `Retry-After` in whole
seconds, write one ledger row per processed attempt, and fail closed when no client is
available.

3.7 WHEN `GET /api/pair/identity` is called in any state THEN it SHALL CONTINUE to answer `200`,
carry no secret and cause no side effect.

3.8 WHEN `GET /api/health` is called THEN it SHALL CONTINUE to answer `200` and SHALL CONTINUE
not to gate readiness on the database, so a database fault never removes a working timer from
rotation.

3.9 WHEN the app is configured THEN it SHALL CONTINUE to require zero new environment
variables.

3.10 WHEN `/api/workouts` and `/api/sessions` are called THEN they SHALL CONTINUE to follow
their existing `200` / `400` / `401` / `503` taxonomy unchanged.

3.11 WHEN the app runs with no sync at all THEN the timer, workout builder, history and sound
settings SHALL CONTINUE to work from browser storage, and the `User`, `Workout` and
`WorkoutSession` tables SHALL CONTINUE to have exactly their current shape.

3.12 WHEN pairing works THEN the scheme itself SHALL CONTINUE to behave as designed — same code
alphabet and grouping, same TTL, digest-only storage, same device and live-code caps, same
two-way merge on claim, same rotation semantics.

### Bug Condition and Properties

The condition, stated over an inbound pairing request together with the deployment state it
lands in.

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type PairingRequest
  OUTPUT: boolean

  // A deployment that believes it can sync, on a database that cannot serve pairing.
  RETURN X.databaseConfigured = TRUE
     AND X.databaseReachable  = TRUE
     AND X.pairingSchemaPresent = FALSE
END FUNCTION
```

The concrete counterexample: `POST /api/pair/code` on the production deployment answers
`500 {"error":"Unexpected server error"}` while `/api/health` reports `sync-capable` and
`/api/pair/identity` reports `syncAvailable: true`.

Three properties must hold for every input satisfying the condition — the response, the
operator's view, and the user's view.

```pascal
// Property 1: Fix Checking — the response is a classified deployment fault, not a crash
FOR ALL X WHERE isBugCondition(X) DO
  result ← handlePairing'(X)
  ASSERT result.status = 503
     AND result.body.reason = schema_not_migrated
     AND result.body CONTAINS NO code, token OR connection_string
END FOR

// Property 2: Fix Checking — the failure is self-reporting
FOR ALL X WHERE isBugCondition(X) DO
  result ← handlePairing'(X)
  ASSERT diagnostics_emitted(X) = 1
     AND names_route_code_and_remedy(diagnostics_emitted(X))
     AND probeIdentity'(X).syncAvailable = FALSE
     AND probeHealth'(X).pairingSchemaReady = FALSE
     AND probeHealth'(X).status = 200
END FOR

// Property 3: Fix Checking — the user is told the truth
FOR ALL X WHERE isBugCondition(X) DO
  message ← syncPanelMessage'(X)
  ASSERT message ≠ notConfiguredCopy
     AND message ≠ unreachableCopy
     AND message STATES server_not_ready AND local_data_safe
END FOR
```

And nothing else may move:

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT handlePairing(X)   = handlePairing'(X)
     AND probeIdentity(X)   = probeIdentity'(X)
     AND syncPanelMessage(X) = syncPanelMessage'(X)
END FOR
```

The non-buggy inputs this quantifies over are precisely the three states enumerated in section
3: no database configured, a configured-but-unreachable database, and a healthy fully migrated
database. `probeHealth` is exempt from byte-equality only in that it gains one additive
readiness field; its status and its independence from the database are preserved by 3.8.
