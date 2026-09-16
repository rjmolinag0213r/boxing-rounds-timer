# 🚂 Deploying to Railway

This guide walks through deploying **Boxing Rounds Timer** (a Next.js 14 app with Prisma + PostgreSQL) to [Railway](https://railway.app). It covers provisioning a database, wiring environment variables, running migrations on each release, and configuring the build/start commands.

> These steps reflect the deployment architecture documented in [`.kiro/specs/boxing-timer-enhancements/design.md`](.kiro/specs/boxing-timer-enhancements/design.md).

---

## Overview

```
GitHub repo  ──►  Railway service (Nixpacks build)  ──►  Next.js server (yarn start)
                          │
                          └──►  Railway PostgreSQL plugin  (DATABASE_URL)
```

Railway auto-detects the Next.js app via Nixpacks, builds it, runs Prisma migrations at release time, and serves it on the port it injects via `$PORT`.

---

## Prerequisites

- A [Railway](https://railway.app) account.
- This repository pushed to GitHub (Railway deploys from a connected repo).
- **Node.js 20+** (pinned in the deploy config below).

---

## Step 1 — Create a Railway project

1. From the Railway dashboard, click **New Project**.
2. Choose **Deploy from GitHub repo** and select `boxing-rounds-timer`.
3. Railway creates a service and starts an initial build using Nixpacks.

---

## Step 2 — Add a PostgreSQL database

1. In your project, click **New → Database → Add PostgreSQL**.
2. Railway provisions a Postgres instance and exposes connection variables (`DATABASE_URL`, `PGHOST`, etc.) on the database service.

---

## Step 3 — Wire up `DATABASE_URL`

Reference the database variable from your **app service** so Prisma can connect:

1. Open the **app service → Variables** tab.
2. Add a variable `DATABASE_URL` and set its value to a reference to the Postgres plugin:

   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ```

   Using a reference (rather than a hardcoded string) keeps credentials in sync if Railway rotates them.

---

## Step 4 — Set application environment variables

Add any additional variables the app needs on the **app service → Variables** tab:

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | ✅ | Reference to the Postgres plugin (Step 3). |
| `NODE_ENV` | Recommended | Set to `production`. |
| `NEXTAUTH_URL` | For sign-in | Your public Railway URL, no trailing slash. |
| `NEXTAUTH_SECRET` | For sign-in | A strong random secret (`openssl rand -base64 32`). |
| `GITHUB_ID` / `GITHUB_SECRET` | One provider required for sign-in | GitHub OAuth app credentials. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Alternative provider | Google OAuth client credentials. |

> `$PORT` is injected automatically by Railway — do not hardcode a port. Next.js `start` respects it.

### Enabling cross-device sync (workouts and history on every device)

Workout history and saved workouts are stored **per device** until a user signs in. Sync is
per-account, so `DATABASE_URL` alone is not enough — accounts are enabled only when **all three**
of these hold:

1. `DATABASE_URL` is set (Step 3).
2. **At least one OAuth provider** is configured (`GITHUB_ID` + `GITHUB_SECRET`, or the Google pair).
3. `NEXTAUTH_URL` **and** `NEXTAUTH_SECRET` are both set.

If 1 and 2 hold but 3 does not, `/api/auth` answers **503** naming the missing variables rather
than signing anyone in against an unsigned cookie.

**Creating a GitHub OAuth app** (the quickest provider to set up):

1. Go to <https://github.com/settings/developers> → **New OAuth App**.
2. **Homepage URL**: your `NEXTAUTH_URL`.
3. **Authorization callback URL**: `<NEXTAUTH_URL>/api/auth/callback/github`.
4. Copy the Client ID into `GITHUB_ID` and a generated client secret into `GITHUB_SECRET`.

See [`.env.example`](.env.example) for every variable with inline notes.

> **Without any of this the app still works** — it simply stays in local-only mode, storing
> workouts and history in the browser. Nothing errors and nothing is lost.

---

## Step 5 — Configure build & release commands

Prisma needs the client generated at build time and migrations applied at release time. Update `package.json` scripts so the client is generated during install/build and add a release step:

```jsonc
{
  "scripts": {
    "dev": "next dev",
    "build": "prisma generate && next build",
    "start": "next start -p ${PORT:-3000}",
    "lint": "next lint",
    "migrate:deploy": "prisma migrate deploy"
  }
}
```

Then tell Railway how to build, release, and start by adding a `railway.json` at the repo root:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "preDeployCommand": "yarn migrate:deploy",
    "startCommand": "yarn start",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

- **`preDeployCommand`** runs `prisma migrate deploy` before each new version goes live, applying any pending migrations to the Railway Postgres database.
- **`startCommand`** boots the Next.js production server.

---

## Step 6 — Pin the Node.js version

Pin Node 20 so Railway builds with a compatible runtime. Add to `package.json`:

```json
{
  "engines": {
    "node": ">=20 <21"
  }
}
```

(Optionally add a `.nvmrc` containing `20` for local parity.)

---

## Step 7 — Create and commit your first migration

The repo currently ships an (essentially empty) Prisma schema. Once you add models (see the enhancement spec), generate an initial migration **locally** against a dev database and commit it:

```bash
# with a local/dev DATABASE_URL set
npx prisma migrate dev --name init
git add prisma/migrations
git commit -m "chore: add initial prisma migration"
```

Committed migrations are what `prisma migrate deploy` applies in production during `preDeployCommand`.

---

## Step 8 — Deploy

1. Push to the branch Railway is watching (e.g. `master`).
2. Railway builds with Nixpacks (`prisma generate && next build`), runs `yarn migrate:deploy`, then starts the server.
3. Open the generated **public URL** (app service → Settings → Networking → Generate Domain).

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `Environment variable not found: DATABASE_URL` | The variable is missing on the **app** service or not referenced from Postgres (Step 3). |
| `PrismaClientInitializationError` at boot | Migrations not applied — confirm `preDeployCommand` ran; check the deploy logs. |
| Build fails on `prisma generate` | Ensure `@prisma/client` and `prisma` are installed and the schema is valid. |
| App not reachable | Generate a public domain, and make sure `start` binds to `$PORT` (do not hardcode `3000`). |
| Wrong Node version | Confirm the `engines.node` pin (Step 6). |

---

## Notes

- Railway sets `PORT` automatically; the `start` script above respects it.
- Prefer variable **references** (`${{Postgres.DATABASE_URL}}`) over pasted connection strings.
- Never commit real secrets — set them in the Railway dashboard.
