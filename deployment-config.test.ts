/**
 * Deterministic assertions over the committed deployment artifacts.
 *
 * Requirement 12 has no universally quantified input space — it is a set of fixed file
 * contents (a migration, four scripts, a Node pin, one release command), so these are
 * literal assertions rather than property tests. They exist to stop a future edit from
 * silently removing the release-phase migration or the `$PORT` binding, which would break
 * the live Railway deploy in ways no unit test would notice.
 *
 * No deployment is performed here, and nothing in this file needs a database.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.11
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname)
const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8')
const readJson = (relative: string): any => JSON.parse(read(relative))

const MIGRATIONS_DIR = 'prisma/migrations'

describe('prisma migrations (requirement 12.1)', () => {
  const migrationDirs = readdirSync(path.join(root, MIGRATIONS_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  const sql = migrationDirs
    .map((dir) => read(path.join(MIGRATIONS_DIR, dir, 'migration.sql')))
    .join('\n')

  it('commits at least one migration', () => {
    expect(migrationDirs.length).toBeGreaterThan(0)
  })

  it('declares the migration provider so `migrate deploy` accepts the directory', () => {
    expect(read(path.join(MIGRATIONS_DIR, 'migration_lock.toml'))).toContain(
      'provider = "postgresql"'
    )
  })

  it.each([
    'User',
    'Account',
    'Session',
    'VerificationToken',
    'Workout',
    'WorkoutSession',
  ])('creates the %s table', (table) => {
    expect(sql).toContain(`CREATE TABLE "${table}"`)
  })

  it('creates the WorkoutType enum', () => {
    expect(sql).toContain(`CREATE TYPE "WorkoutType" AS ENUM ('BOXING', 'MMA', 'CUSTOM')`)
  })

  it('indexes the columns every scoped read filters on', () => {
    expect(sql).toContain('CREATE INDEX "Workout_userId_idx" ON "Workout"("userId")')
    expect(sql).toContain(
      'CREATE INDEX "WorkoutSession_userId_endedAt_idx" ON "WorkoutSession"("userId", "endedAt")'
    )
  })

  it('keeps the denormalized history snapshot columns', () => {
    expect(sql).toContain('"workoutName" TEXT NOT NULL')
    expect(sql).toMatch(/"type" "WorkoutType" NOT NULL/)
  })
})

describe('prisma schema (requirement 12.1, 12.5)', () => {
  const schema = read('prisma/schema.prisma')

  it('reads the connection string from DATABASE_URL', () => {
    expect(schema).toContain('url      = env("DATABASE_URL")')
  })

  it('keeps the original generator binary targets', () => {
    expect(schema).toContain('binaryTargets = ["native", "linux-musl-arm64-openssl-3.0.x"]')
  })

  it('declares @@index([userId]) on Workout and @@index([userId, endedAt]) on WorkoutSession', () => {
    expect(schema).toContain('@@index([userId])')
    expect(schema).toContain('@@index([userId, endedAt])')
  })
})

describe('package.json scripts (requirements 12.6, 12.7, 12.8)', () => {
  const pkg = readJson('package.json')

  it('runs `prisma generate` before `next build`', () => {
    const build: string = pkg.scripts.build
    expect(build).toContain('prisma generate')
    expect(build).toContain('next build')
    expect(build.indexOf('prisma generate')).toBeLessThan(build.indexOf('next build'))
  })

  it('binds the server to the PORT environment variable', () => {
    // `${PORT:-3000}` binds Railway's injected PORT and still runs locally.
    expect(pkg.scripts.start).toMatch(/-p\s+\$\{?PORT/)
  })

  it('exposes `migrate:deploy` as plain `prisma migrate deploy`', () => {
    // Plain, so a failed migration exits non-zero and Railway aborts the deploy
    // (requirement 12.3), and an already-migrated database is a no-op (requirement 12.4).
    expect(pkg.scripts['migrate:deploy']).toBe('prisma migrate deploy')
  })

  it('pins Node to major version 20', () => {
    expect(pkg.engines.node).toBe('>=20 <21')
    expect(read('.nvmrc').trim()).toBe('20')
  })
})

describe('railway.json (requirements 12.2, 12.11)', () => {
  const railway = readJson('railway.json')

  it('runs the migration in the release phase', () => {
    expect(railway.deploy.preDeployCommand).toBe('npm run migrate:deploy')
  })

  it('starts through the $PORT-binding script', () => {
    expect(railway.deploy.startCommand).toBe('npm run start')
  })

  it('points the healthcheck at the readiness endpoint', () => {
    expect(railway.deploy.healthcheckPath).toBe('/api/health')
  })
})
