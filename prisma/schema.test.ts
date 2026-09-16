/**
 * Deterministic assertions over the Prisma schema and the pairing migration.
 *
 * These are file-content assertions, not property tests, and deliberately so: neither file
 * varies with any input, so a hundred randomised iterations would discover nothing a single
 * assertion does not. What they guard is the one way this feature could break a deployment
 * — a migration that is not purely additive.
 *
 * Requirements: 16.1, 16.2, 16.7, 16.9, 16.11
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '..')

const schema = readFileSync(path.join(repoRoot, 'prisma/schema.prisma'), 'utf8')
const migration = readFileSync(
  path.join(repoRoot, 'prisma/migrations/20250917000000_device_pairing_sync/migration.sql'),
  'utf8'
)

/** Counts non-overlapping occurrences of a literal needle. */
const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1

describe('prisma/schema.prisma — pairing models (requirement 16.1)', () => {
  it.each(['SyncSpace', 'PairingCode', 'PairedDevice', 'PairingAttempt'])(
    'declares model %s',
    (model) => {
      expect(schema).toMatch(new RegExp(`^model ${model} \\{`, 'm'))
    }
  )

  it('declares the PairingAttemptKind enum with exactly CREATE and CLAIM', () => {
    const enumBlock = /^enum PairingAttemptKind \{([^}]*)\}/m.exec(schema)
    expect(enumBlock).not.toBeNull()

    const values = (enumBlock as RegExpExecArray)[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//'))

    expect(values).toEqual(['CREATE', 'CLAIM'])
  })

  it('adds exactly one back-relation field to User and no column', () => {
    const userBlock = /^model User \{([\s\S]*?)^\}/m.exec(schema)
    expect(userBlock).not.toBeNull()
    const body = (userBlock as RegExpExecArray)[1]

    // A relation field with an optional model type: no scalar column, so no SQL.
    expect(body).toMatch(/^\s*syncSpace\s+SyncSpace\?\s*$/m)
    // Exactly one reference to the model, and no scalar foreign-key column beside it.
    expect(occurrences(body, 'SyncSpace?')).toBe(1)
    expect(body).not.toMatch(/syncSpaceId/)
  })

  it('gives codeHash and tokenHash a unique constraint (requirement 16.9)', () => {
    expect(schema).toMatch(/codeHash\s+String\s+@unique/)
    expect(schema).toMatch(/tokenHash\s+String\s+@unique/)
  })

  it('relates a SyncSpace one-to-one to its shadow user through a unique key (16.3)', () => {
    const spaceBlock = /^model SyncSpace \{([\s\S]*?)^\}/m.exec(schema)
    expect(spaceBlock).not.toBeNull()
    expect((spaceBlock as RegExpExecArray)[1]).toMatch(/userId\s+String\s+@unique/)
  })

  it('cascades from the shadow user through space, codes, and devices (16.6)', () => {
    expect(schema).toMatch(
      /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/
    )
    // Both PairingCode and PairedDevice cascade from their space.
    expect(
      occurrences(
        schema,
        'syncSpace SyncSpace @relation(fields: [syncSpaceId], references: [id], onDelete: Cascade)'
      )
    ).toBe(2)
  })

  it('leaves Workout and WorkoutSession columns and indexes unchanged (16.2)', () => {
    const workout = /^model Workout \{([\s\S]*?)^\}/m.exec(schema)
    const session = /^model WorkoutSession \{([\s\S]*?)^\}/m.exec(schema)
    expect(workout).not.toBeNull()
    expect(session).not.toBeNull()

    // No pairing-specific scalar was smuggled in; the existing indexes still stand.
    expect((workout as RegExpExecArray)[1]).not.toMatch(/syncSpace/)
    expect((session as RegExpExecArray)[1]).not.toMatch(/syncSpace/)
    expect((workout as RegExpExecArray)[1]).toContain('@@index([userId])')
    expect((session as RegExpExecArray)[1]).toContain('@@index([userId, endedAt])')
  })

  it('declares the indexes the pairing queries depend on', () => {
    const codeBlock = (/^model PairingCode \{([\s\S]*?)^\}/m.exec(schema) as RegExpExecArray)[1]
    expect(codeBlock).toContain('@@index([expiresAt])')
    expect(codeBlock).toContain('@@index([syncSpaceId])')

    const deviceBlock = (/^model PairedDevice \{([\s\S]*?)^\}/m.exec(schema) as RegExpExecArray)[1]
    expect(deviceBlock).toContain('@@index([syncSpaceId])')

    const attemptBlock = (
      /^model PairingAttempt \{([\s\S]*?)^\}/m.exec(schema) as RegExpExecArray
    )[1]
    expect(attemptBlock).toContain('@@index([ipHash, createdAt])')
    expect(attemptBlock).toContain('@@index([createdAt])')
  })
})

describe('the pairing migration is purely additive (requirement 16.7)', () => {
  it('creates exactly the four new tables', () => {
    const created = [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])
    expect(created.sort()).toEqual(['PairedDevice', 'PairingAttempt', 'PairingCode', 'SyncSpace'])
  })

  it('creates exactly one enum type', () => {
    const types = [...migration.matchAll(/CREATE TYPE "(\w+)"/g)].map((m) => m[1])
    expect(types).toEqual(['PairingAttemptKind'])
  })

  it('touches no pre-existing table with ALTER', () => {
    for (const table of ['Workout', 'WorkoutSession', 'User', 'Account', 'Session']) {
      expect(migration).not.toContain(`ALTER TABLE "${table}"`)
    }
  })

  it('confines every ALTER to a foreign key on one of the new tables', () => {
    const altered = [...migration.matchAll(/ALTER TABLE "(\w+)" ADD CONSTRAINT/g)].map((m) => m[1])
    expect(altered.sort()).toEqual(['PairedDevice', 'PairingCode', 'SyncSpace'])
    // Every ALTER in the file is one of those three ADD CONSTRAINTs.
    expect(occurrences(migration, 'ALTER TABLE')).toBe(altered.length)
  })

  it('adds no column to, and drops nothing from, anything', () => {
    expect(migration).not.toMatch(/ADD COLUMN/)
    expect(migration).not.toMatch(/DROP (TABLE|COLUMN|CONSTRAINT|INDEX)/)
    expect(migration).not.toMatch(/ALTER COLUMN/)
    expect(migration).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)\s/im)
  })

  it('carries the unique indexes on codeHash and tokenHash (requirement 16.9)', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX "PairingCode_codeHash_key" ON "PairingCode"("codeHash")')
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "PairedDevice_tokenHash_key" ON "PairedDevice"("tokenHash")'
    )
    expect(migration).toContain('CREATE UNIQUE INDEX "SyncSpace_userId_key" ON "SyncSpace"("userId")')
  })

  it('carries every non-unique index the schema declares', () => {
    for (const statement of [
      'CREATE INDEX "PairingCode_expiresAt_idx" ON "PairingCode"("expiresAt")',
      'CREATE INDEX "PairingCode_syncSpaceId_idx" ON "PairingCode"("syncSpaceId")',
      'CREATE INDEX "PairedDevice_syncSpaceId_idx" ON "PairedDevice"("syncSpaceId")',
      'CREATE INDEX "PairingAttempt_ipHash_createdAt_idx" ON "PairingAttempt"("ipHash", "createdAt")',
      'CREATE INDEX "PairingAttempt_createdAt_idx" ON "PairingAttempt"("createdAt")',
    ]) {
      expect(migration).toContain(statement)
    }
  })

  it('cascades every new foreign key, so one user delete removes the identity (16.6)', () => {
    const foreignKeys = [...migration.matchAll(/ADD CONSTRAINT "(\w+)" FOREIGN KEY[^;]*/g)]
    expect(foreignKeys).toHaveLength(3)
    for (const [statement] of foreignKeys) {
      expect(statement).toContain('ON DELETE CASCADE')
    }
  })
})

describe('the feature adds no configuration (requirements 16.10, 16.11)', () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
  ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }

  it('adds no npm dependency', () => {
    // The pairing modules use only node:crypto, zod, date-fns, and @prisma/client, all of
    // which predate this feature.
    for (const name of ['zod', 'date-fns', '@prisma/client']) {
      expect(packageJson.dependencies).toHaveProperty(name)
    }
    expect(packageJson.dependencies).not.toHaveProperty('ioredis')
    expect(packageJson.dependencies).not.toHaveProperty('redis')
    expect(packageJson.devDependencies).toHaveProperty('fast-check')
  })

  it('leaves migration_lock.toml on postgres and untouched', () => {
    const lock = readFileSync(path.join(repoRoot, 'prisma/migrations/migration_lock.toml'), 'utf8')
    expect(lock).toContain('provider = "postgresql"')
  })
})
