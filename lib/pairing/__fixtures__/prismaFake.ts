/**
 * The in-memory Prisma fake shared by every pairing test.
 *
 * There is no live database in this environment, so this fake is the only thing standing
 * between the pairing properties and vacuity. **Two of its behaviours are load-bearing**, and
 * a permissive shortcut in either would make a property pass while production breaks:
 *
 * 1. **`updateMany` honours its `WHERE` predicate atomically.** The match and the mutation
 *    happen in one synchronous span with no `await` between them, exactly as Postgres's
 *    row-level locking guarantees for `UPDATE … WHERE "consumedAt" IS NULL`. That is what
 *    makes "exactly one of N concurrent claims sees `count === 1`" a real assertion. A fake
 *    that ignored `consumedAt: null` would let Property 8 pass against a double-consuming
 *    implementation.
 * 2. **Every read and write is filtered by the caller's `where`.** Nothing is scoped
 *    implicitly. A handler that forgets `where: { userId }` therefore sees *every* row here,
 *    just as it would in Postgres — which is precisely how Property 15 detects the single
 *    most likely way this feature could leak one user's data to another.
 *
 * Unique constraints on `codeHash` and `tokenHash` throw a `P2002`-shaped error, so a caller
 * that relies on the constraint rather than on a prior read is exercised honestly.
 *
 * This file imports nothing — not `vitest`, not `@prisma/client` — so it typechecks under the
 * application TypeScript project and cannot drag a devDependency into a production build.
 *
 * Requirements: 13.11, 16.11
 */

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

export interface FakeUser {
  id: string
  name: string | null
  email: string | null
  createdAt: Date
}

export interface FakeSyncSpace {
  id: string
  userId: string
  createdAt: Date
  rotatedAt: Date | null
}

export interface FakePairingCode {
  id: string
  syncSpaceId: string
  codeHash: string
  expiresAt: Date
  consumedAt: Date | null
  createdAt: Date
}

export interface FakePairedDevice {
  id: string
  syncSpaceId: string
  tokenHash: string
  label: string
  createdAt: Date
  lastSeenAt: Date
}

export interface FakePairingAttempt {
  id: string
  ipHash: string
  kind: 'CREATE' | 'CLAIM'
  succeeded: boolean
  createdAt: Date
}

export interface FakeWorkout {
  id: string
  userId: string | null
  name: string
  type: string
  rounds: number
  roundSeconds: number
  restSeconds: number
  prepSeconds: number
  isDefault: boolean
  createdAt: Date
  updatedAt: Date
}

export interface FakeWorkoutSession {
  id: string
  userId: string | null
  workoutId: string | null
  workoutName: string
  type: string
  roundsPlanned: number
  roundsCompleted: number
  totalDurationMs: number
  completed: boolean
  startedAt: Date
  endedAt: Date
}

/** Every row the fake holds, exposed for direct assertion. */
export interface FakeStore {
  users: FakeUser[]
  syncSpaces: FakeSyncSpace[]
  pairingCodes: FakePairingCode[]
  pairedDevices: FakePairedDevice[]
  pairingAttempts: FakePairingAttempt[]
  workouts: FakeWorkout[]
  workoutSessions: FakeWorkoutSession[]
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** A `P2002`/`P2025`-shaped error, matching what `@prisma/client` throws. */
export class FakePrismaError extends Error {
  readonly code: string
  readonly meta?: { target?: string[] }

  constructor(code: string, message: string, target?: string[]) {
    super(message)
    this.name = 'PrismaClientKnownRequestError'
    this.code = code
    if (target) this.meta = { target }
  }
}

/** `true` when `error` is the fake's unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof FakePrismaError && error.code === 'P2002'
}

/* -------------------------------------------------------------------------- */
/* Where-clause evaluation                                                     */
/* -------------------------------------------------------------------------- */

type Comparable = number | string | boolean | null

const comparable = (value: unknown): Comparable => {
  if (value instanceof Date) return value.getTime()
  if (value === undefined) return null
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  return value === null ? null : String(value)
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !(value instanceof Date) && !Array.isArray(value)

/** Evaluates one `{ gt, gte, lt, lte, not, in, notIn, equals }` operator bag. */
function matchesOperators(rowValue: unknown, operators: Record<string, unknown>): boolean {
  const actual = comparable(rowValue)

  for (const [operator, operand] of Object.entries(operators)) {
    const expected = comparable(operand)

    switch (operator) {
      case 'equals':
        if (actual !== expected) return false
        break
      case 'not':
        if (actual === expected) return false
        break
      case 'gt':
        if (!(actual !== null && expected !== null && actual > expected)) return false
        break
      case 'gte':
        if (!(actual !== null && expected !== null && actual >= expected)) return false
        break
      case 'lt':
        if (!(actual !== null && expected !== null && actual < expected)) return false
        break
      case 'lte':
        if (!(actual !== null && expected !== null && actual <= expected)) return false
        break
      case 'in':
        if (!Array.isArray(operand) || !operand.map(comparable).includes(actual)) return false
        break
      case 'notIn':
        if (Array.isArray(operand) && operand.map(comparable).includes(actual)) return false
        break
      default:
        throw new Error(`prismaFake: unsupported where operator "${operator}"`)
    }
  }

  return true
}

/**
 * `true` when `row` satisfies `where`.
 *
 * An absent or empty `where` matches everything — deliberately, because that is what Postgres
 * does, and pretending otherwise would hide a missing ownership filter.
 */
export function matchesWhere(row: Record<string, unknown>, where?: Record<string, unknown>): boolean {
  if (!where) return true

  for (const [field, condition] of Object.entries(where)) {
    if (condition === undefined) continue

    if (field === 'AND') {
      const clauses = (Array.isArray(condition) ? condition : [condition]) as Record<
        string,
        unknown
      >[]
      if (!clauses.every((clause) => matchesWhere(row, clause))) return false
      continue
    }

    if (field === 'OR') {
      const clauses = (Array.isArray(condition) ? condition : [condition]) as Record<
        string,
        unknown
      >[]
      if (!clauses.some((clause) => matchesWhere(row, clause))) return false
      continue
    }

    if (field === 'NOT') {
      const clauses = (Array.isArray(condition) ? condition : [condition]) as Record<
        string,
        unknown
      >[]
      if (clauses.some((clause) => matchesWhere(row, clause))) return false
      continue
    }

    const rowValue = row[field]

    if (condition === null) {
      if (comparable(rowValue) !== null) return false
      continue
    }

    if (isPlainObject(condition)) {
      if (!matchesOperators(rowValue, condition)) return false
      continue
    }

    if (comparable(rowValue) !== comparable(condition)) return false
  }

  return true
}

/* -------------------------------------------------------------------------- */
/* The generic table                                                           */
/* -------------------------------------------------------------------------- */

interface Args {
  where?: Record<string, unknown>
  data?: Record<string, unknown>
  select?: Record<string, unknown>
  include?: Record<string, unknown>
  orderBy?: Record<string, 'asc' | 'desc'> | Record<string, 'asc' | 'desc'>[]
  take?: number
  skip?: number
  create?: Record<string, unknown>
  update?: Record<string, unknown>
}

/** A relation the fake can resolve when a `select`/`include` asks for it. */
interface Relation {
  /** The foreign-key field on this row. */
  from: string
  /** The table the key points at. */
  resolve: () => Record<string, unknown>[]
  /** The field on the target row the key matches. */
  to: string
}

interface TableConfig<Row extends object> {
  rows: Row[]
  /** Fields carrying a unique constraint, each reported as `P2002` on violation. */
  unique: readonly (keyof Row & string)[]
  /** Fills defaults and the primary key for `create`. */
  build: (data: Record<string, unknown>) => Row
  relations?: Record<string, Relation>
  name: string
}

/** Index-signature view of a row, so the generic engine can read arbitrary fields. */
const asRecord = (row: object): Record<string, unknown> => row as Record<string, unknown>

const sortRows = <Row extends object>(rows: Row[], orderBy: Args['orderBy']): Row[] => {
  if (!orderBy) return rows
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy]

  return [...rows].sort((left, right) => {
    for (const clause of clauses) {
      for (const [field, direction] of Object.entries(clause)) {
        const a = comparable(asRecord(left)[field])
        const b = comparable(asRecord(right)[field])
        if (a === b) continue
        if (a === null) return direction === 'asc' ? -1 : 1
        if (b === null) return direction === 'asc' ? 1 : -1
        const order = a < b ? -1 : 1
        return direction === 'asc' ? order : -order
      }
    }
    return 0
  })
}

/**
 * One model's delegate.
 *
 * Every method filters through {@link matchesWhere} and returns *copies*, so a test cannot
 * mutate the store by holding onto a result — the same isolation a real client gives.
 */
function createTable<Row extends object>(config: TableConfig<Row>) {
  const project = (row: Row, args: Args): Record<string, unknown> => {
    const relationKeys = Object.keys(config.relations ?? {})
    const shape = args.select ?? args.include

    const withRelations = (base: Record<string, unknown>): Record<string, unknown> => {
      if (!shape) return base

      for (const key of relationKeys) {
        const requested = shape[key]
        if (!requested) continue

        const relation = (config.relations as Record<string, Relation>)[key]
        const target = relation
          .resolve()
          .find(
            (candidate) =>
              comparable(candidate[relation.to]) === comparable(asRecord(row)[relation.from])
          )

        if (!target) {
          base[key] = null
          continue
        }

        const nested = isPlainObject(requested)
          ? ((requested.select ?? requested.include) as Record<string, unknown> | undefined)
          : undefined

        base[key] = nested
          ? Object.fromEntries(
              Object.keys(nested)
                .filter((field) => nested[field])
                .map((field) => [field, target[field]])
            )
          : { ...target }
      }

      return base
    }

    if (args.select) {
      const picked: Record<string, unknown> = {}
      for (const [field, wanted] of Object.entries(args.select)) {
        if (!wanted || relationKeys.includes(field)) continue
        picked[field] = asRecord(row)[field]
      }
      return withRelations(picked)
    }

    return withRelations({ ...asRecord(row) })
  }

  const assertUnique = (candidate: Row, ignore?: Row): void => {
    for (const field of config.unique) {
      const value = asRecord(candidate)[field]
      if (value === null || value === undefined) continue

      const clash = config.rows.some(
        (row) => row !== ignore && comparable(asRecord(row)[field]) === comparable(value)
      )
      if (clash) {
        throw new FakePrismaError(
          'P2002',
          `Unique constraint failed on the fields: (\`${field}\`)`,
          [field]
        )
      }
    }
  }

  const select = (args: Args = {}): Row[] =>
    sortRows(
      config.rows.filter((row) => matchesWhere(asRecord(row), args.where)),
      args.orderBy
    )

  // Each read is generic in its result, defaulting to the table's row type. That is what lets
  // a caller which declares its own structural slice of the client — `RateLimitDb`, say, or a
  // route's narrow view — accept the fake with no cast, while a test that just wants rows
  // still gets them fully typed.
  return {
    async create<T = Row>(args: Args): Promise<T> {
      const row = config.build(args.data ?? {})
      assertUnique(row)
      config.rows.push(row)
      return project(row, args) as T
    },

    async findUnique<T = Row>(args: Args): Promise<T | null> {
      const row = select(args)[0]
      return row ? (project(row, args) as T) : null
    },

    async findFirst<T = Row>(args: Args = {}): Promise<T | null> {
      const row = select(args)[0]
      return row ? (project(row, args) as T) : null
    },

    async findMany<T = Row>(args: Args = {}): Promise<T[]> {
      const matched = select(args)
      const skipped = args.skip ? matched.slice(args.skip) : matched
      const limited = args.take === undefined ? skipped : skipped.slice(0, args.take)
      return limited.map((row) => project(row, args) as T)
    },

    async count(args: Args = {}): Promise<number> {
      return select(args).length
    },

    /**
     * The atomic conditional update.
     *
     * The match and the mutation happen in this one synchronous span, before the promise
     * resolves, so an interleaved caller can never observe a row that matched but has not yet
     * been written. That is the property the single-use guarantee rests on.
     */
    async updateMany(args: Args): Promise<{ count: number }> {
      const matched = config.rows.filter((row) => matchesWhere(asRecord(row), args.where))
      for (const row of matched) {
        Object.assign(row, args.data ?? {})
      }
      return { count: matched.length }
    },

    async update<T = Row>(args: Args): Promise<T> {
      const row = select(args)[0]
      if (!row) {
        throw new FakePrismaError('P2025', `No ${config.name} found for the given where clause`)
      }
      const candidate = { ...asRecord(row), ...(args.data ?? {}) } as Row
      assertUnique(candidate, row)
      Object.assign(row, args.data ?? {})
      return project(row, args) as T
    },

    async upsert<T = Row>(args: Args): Promise<T> {
      const row = select(args)[0]
      if (row) {
        Object.assign(row, args.update ?? {})
        return project(row, args) as T
      }
      const created = config.build({ ...(args.where ?? {}), ...(args.create ?? {}) })
      assertUnique(created)
      config.rows.push(created)
      return project(created, args) as T
    },

    async delete<T = Row>(args: Args): Promise<T> {
      const row = select(args)[0]
      if (!row) {
        throw new FakePrismaError('P2025', `No ${config.name} found for the given where clause`)
      }
      const snapshot = project(row, args) as T
      config.rows.splice(config.rows.indexOf(row), 1)
      return snapshot
    },

    async deleteMany(args: Args = {}): Promise<{ count: number }> {
      const matched = config.rows.filter((row) => matchesWhere(asRecord(row), args.where))
      for (const row of matched) {
        config.rows.splice(config.rows.indexOf(row), 1)
      }
      return { count: matched.length }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The client                                                                  */
/* -------------------------------------------------------------------------- */

export interface PrismaFakeOptions {
  /** Injected clock, so a test can place rows at chosen instants. Defaults to `Date.now`. */
  now?: () => number
  /** Seed rows, written straight into the store without validation. */
  seed?: Partial<FakeStore>
}

export type PrismaFake = ReturnType<typeof createPrismaFake>

/**
 * A hand-rolled Prisma client over an in-memory store.
 *
 * Ids are sequential and prefixed per table (`usr_1`, `spc_1`, …) rather than cuids, so a
 * failing property test prints a counterexample a human can read.
 */
export function createPrismaFake(options: PrismaFakeOptions = {}) {
  const now = options.now ?? (() => Date.now())

  const store: FakeStore = {
    users: [...(options.seed?.users ?? [])],
    syncSpaces: [...(options.seed?.syncSpaces ?? [])],
    pairingCodes: [...(options.seed?.pairingCodes ?? [])],
    pairedDevices: [...(options.seed?.pairedDevices ?? [])],
    pairingAttempts: [...(options.seed?.pairingAttempts ?? [])],
    workouts: [...(options.seed?.workouts ?? [])],
    workoutSessions: [...(options.seed?.workoutSessions ?? [])],
  }

  const counters: Record<string, number> = {}
  const nextId = (prefix: string): string => {
    counters[prefix] = (counters[prefix] ?? 0) + 1
    return `${prefix}_${counters[prefix]}`
  }

  const asDate = (value: unknown, fallback: Date): Date => {
    if (value instanceof Date) return value
    if (typeof value === 'number' || typeof value === 'string') return new Date(value)
    return fallback
  }

  const relationRows = (rows: object[]): Record<string, unknown>[] =>
    rows as Record<string, unknown>[]

  const user = createTable<FakeUser>({
    name: 'User',
    rows: store.users,
    unique: ['id', 'email'],
    build: (data) => ({
      id: (data.id as string) ?? nextId('usr'),
      name: (data.name as string | null) ?? null,
      email: (data.email as string | null) ?? null,
      createdAt: asDate(data.createdAt, new Date(now())),
    }),
  })

  const syncSpace = createTable<FakeSyncSpace>({
    name: 'SyncSpace',
    rows: store.syncSpaces,
    unique: ['id', 'userId'],
    build: (data) => ({
      id: (data.id as string) ?? nextId('spc'),
      userId: data.userId as string,
      createdAt: asDate(data.createdAt, new Date(now())),
      rotatedAt: data.rotatedAt == null ? null : asDate(data.rotatedAt, new Date(now())),
    }),
    relations: {
      user: { from: 'userId', to: 'id', resolve: () => relationRows(store.users) },
    },
  })

  const pairingCode = createTable<FakePairingCode>({
    name: 'PairingCode',
    rows: store.pairingCodes,
    unique: ['id', 'codeHash'],
    build: (data) => ({
      id: (data.id as string) ?? nextId('cod'),
      syncSpaceId: data.syncSpaceId as string,
      codeHash: data.codeHash as string,
      expiresAt: asDate(data.expiresAt, new Date(now())),
      consumedAt: data.consumedAt == null ? null : asDate(data.consumedAt, new Date(now())),
      createdAt: asDate(data.createdAt, new Date(now())),
    }),
    relations: {
      syncSpace: { from: 'syncSpaceId', to: 'id', resolve: () => relationRows(store.syncSpaces) },
    },
  })

  const pairedDevice = createTable<FakePairedDevice>({
    name: 'PairedDevice',
    rows: store.pairedDevices,
    unique: ['id', 'tokenHash'],
    build: (data) => ({
      id: (data.id as string) ?? nextId('dev'),
      syncSpaceId: data.syncSpaceId as string,
      tokenHash: data.tokenHash as string,
      label: (data.label as string) ?? 'Unknown device',
      createdAt: asDate(data.createdAt, new Date(now())),
      lastSeenAt: asDate(data.lastSeenAt, new Date(now())),
    }),
    relations: {
      syncSpace: { from: 'syncSpaceId', to: 'id', resolve: () => relationRows(store.syncSpaces) },
    },
  })

  const pairingAttempt = createTable<FakePairingAttempt>({
    name: 'PairingAttempt',
    rows: store.pairingAttempts,
    unique: ['id'],
    build: (data) => ({
      id: (data.id as string) ?? nextId('att'),
      ipHash: data.ipHash as string,
      kind: data.kind as 'CREATE' | 'CLAIM',
      succeeded: (data.succeeded as boolean) ?? false,
      createdAt: asDate(data.createdAt, new Date(now())),
    }),
  })

  const workout = createTable<FakeWorkout>({
    name: 'Workout',
    rows: store.workouts,
    unique: ['id'],
    build: (data) => ({
      id: (data.id as string) ?? nextId('wkt'),
      userId: (data.userId as string | null) ?? null,
      name: (data.name as string) ?? 'Workout',
      type: (data.type as string) ?? 'BOXING',
      rounds: (data.rounds as number) ?? 3,
      roundSeconds: (data.roundSeconds as number) ?? 180,
      restSeconds: (data.restSeconds as number) ?? 60,
      prepSeconds: (data.prepSeconds as number) ?? 5,
      isDefault: (data.isDefault as boolean) ?? false,
      createdAt: asDate(data.createdAt, new Date(now())),
      updatedAt: asDate(data.updatedAt, new Date(now())),
    }),
  })

  const workoutSession = createTable<FakeWorkoutSession>({
    name: 'WorkoutSession',
    rows: store.workoutSessions,
    unique: ['id'],
    build: (data) => ({
      id: (data.id as string) ?? nextId('ses'),
      userId: (data.userId as string | null) ?? null,
      workoutId: (data.workoutId as string | null) ?? null,
      workoutName: (data.workoutName as string) ?? 'Workout',
      type: (data.type as string) ?? 'BOXING',
      roundsPlanned: (data.roundsPlanned as number) ?? 3,
      roundsCompleted: (data.roundsCompleted as number) ?? 3,
      totalDurationMs: (data.totalDurationMs as number) ?? 0,
      completed: (data.completed as boolean) ?? false,
      startedAt: asDate(data.startedAt, new Date(now())),
      endedAt: asDate(data.endedAt, new Date(now())),
    }),
  })

  /**
   * The model delegates, named separately from the client so `$transaction` can hand them to
   * its callback without the client's type referring to itself.
   */
  const delegates = {
    user,
    syncSpace,
    pairingCode,
    pairedDevice,
    pairingAttempt,
    workout,
    workoutSession,
  }

  const client = {
    ...delegates,

    /**
     * Runs `body` immediately against the same store.
     *
     * No rollback is modelled, and that is an honest limitation rather than an oversight: a
     * fake cannot reproduce Postgres's abort semantics, and the routes that use a transaction
     * here do so for atomicity of a *sequence of inserts*, whose partial-failure behaviour is
     * a real-database concern the design flags as first exercised on deploy.
     */
    async $transaction<T>(
      body: ((tx: typeof delegates) => Promise<T>) | Promise<unknown>[]
    ): Promise<T | unknown[]> {
      if (Array.isArray(body)) return Promise.all(body)
      return body(delegates)
    },

    /** The raw rows, for assertions. */
    store,

    /** Convenience: the whole store as a JSON string, for "the token appears nowhere" checks. */
    serialize(): string {
      return JSON.stringify(store)
    },
  }

  return client
}

/**
 * A `@/lib/db` stand-in backed by the fake, for `vi.mock('@/lib/db', …)`.
 *
 * Typed loosely on purpose: every consumer of `getPrismaClient()` in this feature declares the
 * structural slice of the client it needs, so the fake satisfies each of them without a cast
 * at the call site.
 */
export function fakeDatabaseModule(fake: PrismaFake): {
  getPrismaClient: () => PrismaFake
  databaseConfigured: () => boolean
} {
  return {
    getPrismaClient: () => fake,
    databaseConfigured: () => true,
  }
}

/**
 * The absent-database variant: `getPrismaClient()` returns `null`, exactly as it does when
 * `DATABASE_URL` is unset. Local-only is a supported state, so every consumer has to have a
 * `null` branch and this is what proves it does.
 */
export function absentDatabaseModule(): {
  getPrismaClient: () => null
  databaseConfigured: () => boolean
} {
  return {
    getPrismaClient: () => null,
    databaseConfigured: () => false,
  }
}
