/**
 * The Prisma client accessor.
 *
 * The client is created **lazily**, and only when `DATABASE_URL` is set. That is what lets
 * the app boot and serve the timer with no database configured at all — Local_Only_Mode,
 * requirement 12.10 — and it also keeps `next build` from constructing a client while
 * collecting the route handlers on a machine that has no database.
 *
 * Callers that need a connection ask for one and handle `null`:
 *
 * ```ts
 * const db = getPrismaClient()
 * if (!db) return databaseUnavailable() // 503, requirement 8.9
 * ```
 *
 * Requirements: 8.9, 12.5, 12.10
 */

import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/** `true` when a non-empty `DATABASE_URL` is present in the environment. */
export function databaseConfigured(): boolean {
  const url = process.env.DATABASE_URL
  return typeof url === 'string' && url.trim().length > 0
}

/**
 * The process-wide Prisma client, or `null` when no database is configured (or the client
 * cannot be constructed — a malformed connection string, for instance).
 *
 * The instance is cached on `globalThis` so Next's dev-mode module reloading does not leak
 * a new connection pool on every edit.
 */
export function getPrismaClient(): PrismaClient | null {
  if (!databaseConfigured()) return null
  if (globalForPrisma.prisma) return globalForPrisma.prisma

  try {
    const client = new PrismaClient()
    // Cached in every environment: a route handler in production benefits from the pool
    // just as much as a hot-reloading dev server does.
    globalForPrisma.prisma = client
    return client
  } catch {
    // A construction failure is indistinguishable, from the caller's point of view, from
    // an absent database: both mean "no server-side persistence right now" -> 503.
    return null
  }
}
