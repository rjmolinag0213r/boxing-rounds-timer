/**
 * Optional accounts.
 *
 * Accounts are strictly additive here: the timer, the builder and history all work with no
 * account and no database at all (Local_Only_Mode, requirement 12.10). Signing in exists for
 * exactly one reason — a workout saved on a phone should also be there on a computer — so
 * every function in this module is written to degrade to "anonymous" rather than to fail.
 *
 * Accounts are considered *enabled* only when all three of these hold:
 *
 * 1. `DATABASE_URL` is set (there is somewhere to store users and sessions);
 * 2. at least one OAuth provider is configured;
 * 3. `NEXTAUTH_URL` and `NEXTAUTH_SECRET` are both present (requirement 12.9).
 *
 * If (1) or (2) is missing the app is simply anonymous-only. If (1) and (2) hold but (3) does
 * not, that is a *misconfiguration*: the auth route reports 503 naming the missing variables
 * instead of silently signing people in against an unsigned cookie.
 *
 * Requirements: 8.6, 8.7, 12.9, 12.10
 */

import { PrismaAdapter } from '@next-auth/prisma-adapter'
import type { NextAuthOptions } from 'next-auth'
import { getServerSession } from 'next-auth/next'
import GitHubProvider from 'next-auth/providers/github'
import GoogleProvider from 'next-auth/providers/google'

import { databaseConfigured, getPrismaClient } from '@/lib/db'

/** The environment variables required wherever accounts are enabled (requirement 12.9). */
export const REQUIRED_AUTH_ENV_VARS = ['NEXTAUTH_URL', 'NEXTAUTH_SECRET'] as const

const present = (value: string | undefined): boolean =>
  typeof value === 'string' && value.trim().length > 0

/** Builds the provider list from whatever OAuth credentials the environment supplies. */
function configuredProviders(): NextAuthOptions['providers'] {
  const providers: NextAuthOptions['providers'] = []

  if (present(process.env.GITHUB_ID) && present(process.env.GITHUB_SECRET)) {
    providers.push(
      GitHubProvider({
        clientId: process.env.GITHUB_ID as string,
        clientSecret: process.env.GITHUB_SECRET as string,
      })
    )
  }

  if (present(process.env.GOOGLE_CLIENT_ID) && present(process.env.GOOGLE_CLIENT_SECRET)) {
    providers.push(
      GoogleProvider({
        clientId: process.env.GOOGLE_CLIENT_ID as string,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      })
    )
  }

  return providers
}

/** Why accounts are unavailable, when they are. */
export type AuthAvailability =
  /** No database and/or no provider: the app is anonymous-only by design. */
  | { status: 'disabled'; reason: 'no-database' | 'no-provider' }
  /** Accounts were asked for but `NEXTAUTH_URL`/`NEXTAUTH_SECRET` are missing. */
  | { status: 'misconfigured'; missing: string[] }
  | { status: 'enabled' }

/** Reports whether optional accounts are usable, and if not, precisely why. */
export function authAvailability(): AuthAvailability {
  if (!databaseConfigured()) return { status: 'disabled', reason: 'no-database' }
  if (configuredProviders().length === 0) return { status: 'disabled', reason: 'no-provider' }

  const missing = REQUIRED_AUTH_ENV_VARS.filter((name) => !present(process.env[name]))
  if (missing.length > 0) return { status: 'misconfigured', missing: [...missing] }

  return { status: 'enabled' }
}

/** `true` only when a sign-in attempt can actually succeed. */
export function accountsEnabled(): boolean {
  return authAvailability().status === 'enabled'
}

/**
 * The next-auth configuration, or `null` when accounts are not enabled.
 *
 * Database-backed sessions are used (not JWTs) because the adapter already stores them and a
 * database session can be revoked — and because `session.user.id` then comes straight from
 * the `User` row that owns the synced workouts.
 */
export function buildAuthOptions(): NextAuthOptions | null {
  if (!accountsEnabled()) return null

  const prisma = getPrismaClient()
  if (!prisma) return null

  return {
    // The adapter's generated types lag the Prisma client's; the runtime contract is exact.
    adapter: PrismaAdapter(prisma) as NextAuthOptions['adapter'],
    providers: configuredProviders(),
    session: { strategy: 'database' },
    secret: process.env.NEXTAUTH_SECRET,
    callbacks: {
      /** Surfaces the owning `User.id`, which every scoped query filters on (requirement 8.6). */
      async session({ session, user }) {
        if (session.user && user) {
          session.user.id = user.id
        }
        return session
      },
    },
  }
}

/**
 * How a route handler should treat the caller.
 *
 * `database-error` is distinct from `anonymous` on purpose: a request that arrives while the
 * database is down must answer 503 ("retry later, keep your local copy") rather than 401
 * ("you are not signed in"), or the client would wrongly conclude it had been signed out
 * (requirements 8.9, 8.10).
 */
export type AuthResolution =
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; userId: string }
  | { kind: 'database-error'; error: unknown }

/** Resolves the caller's optional account, for use by the data route handlers. */
export async function resolveAuth(): Promise<AuthResolution> {
  const options = buildAuthOptions()
  if (!options) return { kind: 'anonymous' }

  try {
    const session = await getServerSession(options)
    const userId = session?.user?.id
    return typeof userId === 'string' && userId.length > 0
      ? { kind: 'authenticated', userId }
      : { kind: 'anonymous' }
  } catch (error) {
    return { kind: 'database-error', error }
  }
}

/**
 * The authenticated `userId`, or `null` when the caller is anonymous (or the session store
 * could not be read). The thin form of {@link resolveAuth}, for callers with nothing useful
 * to do about a database failure.
 */
export async function getAuthenticatedUserId(): Promise<string | null> {
  const resolution = await resolveAuth()
  return resolution.kind === 'authenticated' ? resolution.userId : null
}
