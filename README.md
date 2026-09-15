# 🥊 Boxing Rounds Timer

A clean, mobile-friendly round timer for boxing and combat-sports training. Configure your rounds, round length, and rest periods, save your favorite workouts as presets, and let the timer keep you honest with audible bell / buzzer / warning cues.

Built with **Next.js 14 (App Router)**, **TypeScript**, **Tailwind CSS**, and a shadcn/ui-style component library.

---

## ✨ Features

- **Round-based interval timer** with prep, work (round), and rest phases plus a "workout complete" state.
- **Configurable workouts** — number of rounds, round duration, and rest duration.
- **Presets** — save, load, and delete named workouts (persisted in the browser).
- **Sensible defaults** — Classic 12×3, Amateur 3×2, and Speed 10×1 boxing presets out of the box.
- **Audio cues** — synthesized round-start bell, rest buzzer, and last-3-seconds warning ticks (mute toggle included), with no external audio files required.
- **Animated circular timer** with per-phase color coding and a live progress ring.
- **Light / dark mode** via `next-themes`.

> 📋 A comprehensive set of planned enhancements — an accurate background timer, custom & uploadable sounds, workout history, a Boxing/MMA custom-workout builder, a red-and-white UI refresh, PWA install support, and Railway deployment — is documented as a technical spec under [`.kiro/specs/boxing-timer-enhancements/`](.kiro/specs/boxing-timer-enhancements/).

---

## 🚀 Getting Started

### Prerequisites

- **Node.js 20+**
- A package manager (`npm`, `yarn`, or `pnpm`) — this repo is configured for **Yarn** (`.yarnrc.yml`).

### Install

```bash
# using yarn (repo default)
yarn install

# or with npm
npm install
```

### Run the development server

```bash
yarn dev
# or: npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build & run for production

```bash
yarn build && yarn start
# or: npm run build && npm run start
```

---

## 🧾 Available Scripts

| Script  | Description                          |
|---------|--------------------------------------|
| `dev`   | Start the Next.js development server |
| `build` | Create a production build            |
| `start` | Run the production server            |
| `lint`  | Run ESLint                           |

---

## 📁 Project Structure

```
.
├── app/
│   ├── _components/boxing-timer.tsx   # Main timer UI + logic
│   ├── globals.css                    # Design tokens (theme) + global styles
│   ├── layout.tsx                     # Root layout, providers, fonts
│   └── page.tsx                       # Entry point (renders BoxingTimer)
├── components/                        # shadcn/ui-style component library
├── hooks/                             # Reusable React hooks
├── lib/
│   ├── audio.ts                       # Web Audio API sound generation
│   ├── presets.ts                     # Preset model + localStorage persistence
│   ├── db.ts                          # Prisma client
│   └── utils.ts                       # Helpers
├── prisma/schema.prisma               # Prisma schema (PostgreSQL)
├── public/                            # Static assets
├── STYLE_GUIDE.md                     # Design system & component reference
└── .kiro/specs/                       # Feature specifications
```

---

## ⚙️ Configuration

The app currently runs fully client-side. Persistent, server-backed features (workout history, optional accounts) described in the enhancement spec use Prisma with **PostgreSQL** via a `DATABASE_URL` environment variable:

```bash
# .env
DATABASE_URL="postgresql://user:password@host:5432/dbname"
```

---

## 🎨 Styling

Colors are driven entirely by CSS variable **design tokens** (see `app/globals.css` and `STYLE_GUIDE.md`) mapped to Tailwind utilities — **never hardcode color values**. Typography uses DM Sans (body), Plus Jakarta Sans (display), and JetBrains Mono (numeric/timestamps).

---

## 🚂 Deployment

This app is designed to deploy to **Railway** with a managed PostgreSQL database. See [`DEPLOYMENT.md`](DEPLOYMENT.md) for a full step-by-step guide.

---

## 📱 Roadmap

See [`.kiro/specs/boxing-timer-enhancements/design.md`](.kiro/specs/boxing-timer-enhancements/design.md) for the full technical design. Highlights:

- ⏱️ **Wall-clock timer engine** so the timer stays accurate after the app is backgrounded on mobile.
- 🔊 **Custom & uploadable alert sounds** with per-event assignment.
- 📊 **Workout history** with per-session records and weekly totals.
- 🥋 **Boxing & MMA custom-workout builder** with type-aware defaults (e.g. MMA 5×5-min).
- 🎨 **Red-and-white UI refresh** driven by design tokens.
- 📲 **Installable PWA** (add-to-home-screen, standalone display).
- 🚂 **Railway deployment** with managed PostgreSQL and migrations.

---

## 📄 License

No license file is currently included in this repository. All rights reserved by the repository owner unless a license is added.
