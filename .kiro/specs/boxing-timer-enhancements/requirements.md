# Requirements Document

## Introduction

This document specifies the requirements for the **boxing-timer-enhancements** feature set, derived
from the approved design document (`design.md`) for the existing `boxing-rounds-timer` application
(Next.js 14.2 App Router + TypeScript, currently a single client component at
`app/_components/boxing-timer.tsx`).

The requirements cover eight scope areas established by the design:

1. An accurate timer that survives mobile backgrounding (wall-clock engine replacing tick counting).
2. Custom sound selection, including user-uploaded audio, per sound role.
3. Workout history persisted across devices for signed-in users.
4. A custom workout builder supporting Boxing and MMA formats.
5. A red-and-white UI refresh driven by design tokens.
6. An installable Progressive Web App.
7. Deployment readiness for the database-backed features on Railway.
8. Removal of unrelated dead code.

**Verified starting state.** None of these capabilities exist in the deployed application today. The
timer decrements a React state value inside `setInterval`; `lib/presets.ts` holds three Boxing
presets and no workout-type field; `lib/audio.ts` exposes three hard-coded synthesized tones with no
selection or upload; saved workouts live only in browser `localStorage`, so a workout saved on a
phone does not appear on a computer; `app/globals.css` defines `--primary` as purple
(`262 83% 58%` light / `263 70% 50%` dark) while `boxing-timer.tsx` hard-codes 12 `red-500`/`red-600`
utilities; there is no manifest and no service worker; `lib/types.ts` contains expenses-app
boilerplate. Requirements are written against this starting state.

**Out of scope.** See the [Out of Scope](#out-of-scope) section at the end of this document.

---

## Glossary

- **Timer_Engine**: The pure wall-clock timing module (`lib/timer/`) comprising `buildPlan`,
  `effectiveElapsedMs`, `segmentAt`, and `snapshot`, together with its React binding
  `useTimerEngine`. Owns all timing correctness.
- **Timer_View**: The timer screen component (`app/_components/boxing-timer.tsx`), which renders the
  Timer_Engine snapshot and hosts the primary controls.
- **Workout_Spec**: The four configurable durations of a workout: `prepSeconds`, `rounds`,
  `roundSeconds`, `restSeconds`.
- **Segment**: One contiguous timed interval within a workout, of kind `prep`, `round`, or `rest`,
  with a duration and a cumulative start offset from workout start.
- **Timeline_Plan**: The ordered, immutable list of Segments derived once from a Workout_Spec, plus
  the workout's `totalMs`.
- **Phase**: The user-visible state of the timer: `idle`, `prep`, `round`, `rest`, `paused`, or
  `finished`.
- **Effective_Elapsed_Time**: Wall-clock time elapsed since workout start, minus all time spent
  paused, clamped to `[0, Timeline_Plan.totalMs]`.
- **Reconciliation**: A single recomputation of the Timer_Engine snapshot from the current wall-clock
  timestamp, triggered by the render driver or by a `visibilitychange` event.
- **Sound_Role**: One of the four alert slots: `roundStart`, `restStart`, `warningTick`, `finished`.
- **Sound_Source**: The origin of audio for a Sound_Role: a synthesized tone (`synth`), a bundled
  asset under `public/sounds/` (`builtin`), or a user upload (`custom`).
- **Sound_Engine**: The audio module (`lib/audio/soundEngine.ts`) that plays, pre-schedules, and
  configures sounds per Sound_Role.
- **Custom_Sound_Store**: The IndexedDB blob store (`lib/audio/customStore.ts`) holding validated
  user-uploaded audio files, keyed by `blobId`.
- **Sound_Settings_View**: The component (`app/_components/sound-settings.tsx`) for assigning,
  previewing, uploading, and muting sounds.
- **Workout**: A reusable, named workout definition: name, workout type, and Workout_Spec values.
- **Workout_Type**: One of `BOXING`, `MMA`, or `CUSTOM`.
- **Workout_Session**: A history record of one completed or stopped run of a Workout.
- **Workout_Builder**: The component (`app/_components/workout-builder.tsx`) for creating and editing
  Workouts.
- **History_View**: The component (`app/_components/history-view.tsx`) that lists Workout_Sessions
  and their aggregates.
- **Workout_Repository**: The persistence abstraction (`lib/data/workoutRepository.ts`) with local,
  remote, and syncing implementations, used by Timer_View, Workout_Builder, and History_View.
- **Workouts_API**: The route handlers at `app/api/workouts/`.
- **Sessions_API**: The route handlers at `app/api/sessions/`.
- **Authenticated_Session**: A valid next-auth session identifying a `userId`.
- **Local_Only_Mode**: Operation with no Authenticated_Session, where all data is read from and
  written to browser storage only.
- **Theme_System**: The design-token layer: the CSS custom properties in `app/globals.css`
  (`:root` and `.dark`) and their Tailwind mappings in `tailwind.config.ts`.
- **PWA_Shell**: The installability layer: `public/manifest.webmanifest`, the document metadata in
  `app/layout.tsx`, icons under `public/icons/`, and the service-worker registration component.
- **Service_Worker**: The script at `public/sw.js` providing offline caching.
- **Deployment_Pipeline**: The Railway build, release, and start sequence configured by
  `package.json` scripts and `railway.json`.

---

## Requirements

### Requirement 1: Accurate Timing Across Backgrounding

**User Story:** As a boxer training on my phone, I want the timer to stay accurate when I switch apps
or lock the screen, so that my rounds are the length I configured rather than however long the
browser let JavaScript run.

#### Acceptance Criteria

1. THE Timer_Engine SHALL derive the remaining time of the current Segment from the difference
   between a supplied wall-clock timestamp and the Segment's absolute end boundary, rather than from
   a decremented tick counter.
2. THE Timer_Engine SHALL compute every snapshot as a pure function of the engine state and the
   supplied wall-clock timestamp, so that two evaluations with the same state and the same timestamp
   produce identical snapshots.
3. WHILE the Timer_Engine status is `running`, THE Timer_Engine SHALL report an Effective_Elapsed_Time
   that is greater than or equal to the value reported for any earlier supplied timestamp.
4. WHILE the Timer_Engine status is `paused`, THE Timer_Engine SHALL report the same
   Effective_Elapsed_Time for every supplied timestamp.
5. WHEN document visibility changes from hidden to visible after a hidden interval of any length, THE
   Timer_Engine SHALL perform a Reconciliation within 250 ms of the `visibilitychange` event.
6. WHEN the Timer_Engine is evaluated with a single timestamp advance of D milliseconds, THE
   Timer_Engine SHALL produce the same Phase, current round number, and remaining milliseconds as
   evaluation through any sequence of smaller timestamp advances whose sum is D milliseconds.
7. WHEN the user pauses a running workout and later resumes it, THE Timer_Engine SHALL add the
   wall-clock duration of that pause to accumulated pause time and exclude it from
   Effective_Elapsed_Time.
8. THE Timer_Engine SHALL represent `paused` as a status distinct from `idle`, `running`, and
   `finished`.
9. IF the supplied timestamp is earlier than the workout start timestamp, THEN THE Timer_Engine SHALL
   clamp Effective_Elapsed_Time to 0 milliseconds and report remaining milliseconds greater than or
   equal to 0 and progress percentage within the range 0 to 100 inclusive.
10. IF the supplied timestamp is later than the workout start timestamp plus `Timeline_Plan.totalMs`,
    THEN THE Timer_Engine SHALL clamp Effective_Elapsed_Time to `Timeline_Plan.totalMs` and report
    Phase `finished`.
11. WHILE the document is visible and the Timer_Engine status is `running`, THE Timer_View SHALL
    refresh the displayed remaining time at least once every 250 milliseconds.
12. THE Timer_View SHALL derive all displayed timing values from the Timer_Engine snapshot, holding
    no independent countdown state.

---

### Requirement 2: Deterministic Workout Timeline and Phase Progression

**User Story:** As a user of any workout format, I want prep, rounds, and rests to occur in the right
order with the right durations, so that the timer matches the format I selected even after the app
was backgrounded across several transitions.

#### Acceptance Criteria

1. WHEN a Workout_Spec with `rounds` greater than or equal to 1, `roundSeconds` greater than or equal
   to 1, `restSeconds` greater than or equal to 0, and `prepSeconds` greater than or equal to 0 is
   supplied, THE Timer_Engine SHALL build a Timeline_Plan containing exactly `rounds` Segments of
   kind `round`.
2. WHERE `prepSeconds` is greater than 0, THE Timer_Engine SHALL place exactly one Segment of kind
   `prep` at position 0 of the Timeline_Plan with duration `prepSeconds` seconds.
3. WHERE `prepSeconds` equals 0, THE Timer_Engine SHALL build a Timeline_Plan containing zero
   Segments of kind `prep`.
4. WHERE `restSeconds` is greater than 0, THE Timer_Engine SHALL place exactly `rounds - 1` Segments
   of kind `rest`, each positioned between two consecutive Segments of kind `round`.
5. WHERE `restSeconds` equals 0, THE Timer_Engine SHALL build a Timeline_Plan containing zero
   Segments of kind `rest`.
6. THE Timer_Engine SHALL build Timeline_Plans in which each Segment's offset equals the sum of all
   preceding Segment durations, and in which `totalMs` equals the sum of all Segment durations.
7. WHEN Effective_Elapsed_Time advances from 0 to `Timeline_Plan.totalMs`, THE Timer_Engine SHALL
   report the Timeline_Plan's Segments as active in plan order, reporting each Segment in at most one
   contiguous run and omitting no Segment.
8. WHEN Effective_Elapsed_Time equals a Segment's end offset and a later Segment exists, THE
   Timer_Engine SHALL report the immediately following Segment as active.
9. WHEN Effective_Elapsed_Time equals `Timeline_Plan.totalMs`, THE Timer_Engine SHALL report the
   final Segment as active and Phase `finished`.
10. IF a single Reconciliation crosses one or more Segment boundaries, THEN THE Timer_Engine SHALL
    emit exactly one Phase-transition sound event, identifying the Segment in which the
    Reconciliation landed.
11. IF a supplied Workout_Spec violates a bound stated in acceptance criterion 2.1, THEN THE
    Timer_Engine SHALL reject the Workout_Spec and report a validation error naming the offending
    field.
12. WHEN the user stops a running or paused workout, THE Timer_Engine SHALL return to status `idle`
    and report Effective_Elapsed_Time of 0 milliseconds.

---

### Requirement 3: Custom Sound Selection and Upload

**User Story:** As a user, I want to choose which sound plays for each timer event and to upload my
own bell or air horn, so that my workout sounds the way I want instead of using three fixed tones.

#### Acceptance Criteria

1. THE Sound_Engine SHALL support exactly four Sound_Roles: `roundStart`, `restStart`, `warningTick`,
   and `finished`.
2. THE Sound_Settings_View SHALL present, for each Sound_Role, a selection control listing every
   available synthesized tone, every bundled asset under `public/sounds/`, and every audio file held
   in the Custom_Sound_Store.
3. WHEN the user assigns a Sound_Source to a Sound_Role, THE Sound_Engine SHALL use that Sound_Source
   for every subsequent playback of that Sound_Role.
4. WHEN the user uploads a file whose MIME type matches `audio/*`, whose size is less than or equal
   to 5 megabytes, and whose decoded duration is less than or equal to 10 seconds, THE
   Custom_Sound_Store SHALL persist the file in IndexedDB under a generated `blobId` and THE
   Sound_Settings_View SHALL list it as selectable for every Sound_Role.
5. IF an uploaded file exceeds 5 megabytes, exceeds 10 seconds of decoded duration, carries a MIME
   type outside `audio/*`, or fails to decode, THEN THE Sound_Settings_View SHALL display an error
   message identifying the failed validation, discard the file, and retain the previously assigned
   Sound_Source for every Sound_Role.
6. WHEN the application is reloaded, THE Sound_Engine SHALL restore the persisted muted state, volume
   value, and all four Sound_Role assignments.
7. IF the Sound_Source assigned to a Sound_Role fails to load or decode at playback time, THEN THE
   Sound_Engine SHALL play the synthesized tone associated with that Sound_Role.
8. THE Sound_Engine SHALL apply the configured volume, a value within the range 0 to 1 inclusive, as
   the output gain of every playback.
9. WHILE the muted setting is enabled, THE Sound_Engine SHALL produce no audible output for any
   Sound_Role.
10. WHEN the user activates the preview control for a Sound_Role in the Sound_Settings_View, THE
    Sound_Engine SHALL play the Sound_Source currently assigned to that Sound_Role once at the
    configured volume.
11. WHEN the user deletes an audio file from the Custom_Sound_Store, THE Sound_Engine SHALL reassign
    every Sound_Role that referenced the deleted `blobId` to the synthesized tone associated with
    that Sound_Role.

---

### Requirement 4: Boundary Alerts and Documented Background-Audio Limits

**User Story:** As a user, I want the bell to fire on time during a workout and I want the app to tell
me plainly what happens to audio when my phone is locked, so that I can trust the alerts and know
when to keep the screen on.

#### Acceptance Criteria

1. WHEN the user activates the Start control, THE Sound_Engine SHALL unlock and resume the
   AudioContext within that user-gesture handler.
2. WHEN a Segment becomes active, THE Sound_Engine SHALL pre-schedule that Segment's boundary sound
   and its warning-tick sounds against the AudioContext clock.
3. WHILE the final 3 seconds of a Segment of kind `round` elapse, THE Sound_Engine SHALL play the
   `warningTick` Sound_Role once per remaining whole second.
4. IF a pre-scheduled sound's scheduled time has already passed at the moment of Reconciliation, THEN
   THE Sound_Engine SHALL discard that scheduled sound without playing it.
5. WHEN document visibility changes from hidden to visible, THE Sound_Engine SHALL resume the
   AudioContext and re-schedule only those boundary sounds whose scheduled times are in the future.
6. THE Timer_View SHALL display a notice stating that iOS suspends web audio while the browser is
   backgrounded or the screen is locked, and that the timer remains accurate when the app returns to
   the foreground.
7. WHERE the user has granted notification permission, THE Timer_View SHALL post a visual
   notification at each transition into a Segment of kind `round` or `rest`.
8. THE Sound_Settings_View SHALL display the same background-audio limitation notice described in
   acceptance criterion 4.6.

---

### Requirement 5: Custom Workout Builder for Boxing and MMA

**User Story:** As a fighter who trains in both boxing and MMA, I want to pick a workout type and
build my own round structure, so that I can run 5-minute MMA championship rounds as easily as
3-minute boxing rounds instead of being limited to three fixed boxing presets.

#### Acceptance Criteria

1. THE Workout_Builder SHALL provide a Workout_Type selector offering the values `BOXING`, `MMA`, and
   `CUSTOM`.
2. THE Workout_Builder SHALL provide editable inputs for workout name, number of rounds, round
   duration, rest duration, and prep duration.
3. THE Workout_Repository SHALL provide the Boxing default Workouts "Classic 12×3" (12 rounds, 180 s
   round, 60 s rest, 5 s prep), "Amateur 3×2" (3 rounds, 120 s round, 60 s rest, 5 s prep), and
   "Speed 10×1" (10 rounds, 60 s round, 30 s rest, 5 s prep), each with Workout_Type `BOXING`.
4. THE Workout_Repository SHALL provide the MMA default Workouts "Championship 5×5" (5 rounds, 300 s
   round, 60 s rest, 10 s prep) and "Regular 3×5" (3 rounds, 300 s round, 60 s rest, 10 s prep), each
   with Workout_Type `MMA`.
5. WHEN the user selects a Workout_Type in the Workout_Builder, THE Workout_Builder SHALL list the
   default Workouts of that Workout_Type as starting points.
6. WHEN the user submits a Workout whose name length is within 1 to 60 characters, whose rounds value
   is within 1 to 99, whose round duration is within 1 to 3600 seconds, whose rest duration is within
   0 to 600 seconds, and whose prep duration is within 0 to 60 seconds, THE Workout_Repository SHALL
   persist the Workout and THE Workout_Builder SHALL display a success confirmation.
7. IF a submitted Workout has an empty name or a value outside the bounds stated in acceptance
   criterion 5.6, THEN THE Workout_Builder SHALL display a validation message identifying the
   offending field and retain the user's entered values without persisting the Workout.
8. WHEN the user selects a saved Workout WHILE the Timer_Engine status is `idle`, THE Timer_View SHALL
   load that Workout's rounds, round duration, rest duration, and prep duration into the active
   Workout_Spec.
9. WHEN the user deletes a saved Workout, THE Workout_Repository SHALL remove that Workout from
   storage and retain every existing Workout_Session record.
10. WHEN the application loads and finds presets stored under the key `boxing_timer_presets_v1`, THE
    Workout_Repository SHALL write an equivalent record for each preset under
    `boxing_timer_presets_v2`, assigning Workout_Type `BOXING` and prep duration 5 seconds, and
    preserving the stored `id`, `name`, `rounds`, `roundSeconds`, `restSeconds`, and `createdAt`
    values.
11. WHEN the migration described in acceptance criterion 5.10 has already produced
    `boxing_timer_presets_v2`, THE Workout_Repository SHALL leave the stored records unchanged on
    every subsequent load.
12. WHERE a stored Workout record lacks a Workout_Type field, THE Workout_Repository SHALL treat that
    Workout as Workout_Type `BOXING`.

---

### Requirement 6: Workout History Recording

**User Story:** As a user, I want each finished or stopped workout to be recorded, so that I can see
what training I have actually done rather than losing every session the moment it ends.

#### Acceptance Criteria

1. WHEN the Timer_Engine reaches Phase `finished`, THE Workout_Repository SHALL record a
   Workout_Session containing the workout name, Workout_Type, planned round count, completed round
   count, total duration in milliseconds, a completed flag set to true, the workout start timestamp,
   and the workout end timestamp.
2. WHEN the user stops a running or paused workout before Phase `finished` is reached, THE
   Workout_Repository SHALL record a Workout_Session with the completed flag set to false and a
   completed round count equal to the number of Segments of kind `round` that fully elapsed.
3. THE Workout_Repository SHALL record a total duration equal to the Effective_Elapsed_Time reported
   by the Timer_Engine at the moment of recording, excluding time spent paused.
4. THE Workout_Repository SHALL record the workout name and Workout_Type as values stored on the
   Workout_Session itself, independent of the Workout definition.
5. IF a Workout_Session has a completed round count outside the range 0 to the planned round count
   inclusive, or a total duration less than 0, THEN THE Sessions_API SHALL reject the record with a
   validation error and THE Workout_Repository SHALL report the failure to the caller.
6. WHEN a Workout definition is deleted after Workout_Sessions referencing it exist, THE History_View
   SHALL continue to display each affected Workout_Session's stored workout name and Workout_Type.
7. IF recording a Workout_Session to the server fails, THEN THE Workout_Repository SHALL retain the
   Workout_Session in local storage and mark the record as pending synchronization.

---

### Requirement 7: History View and Aggregates

**User Story:** As a user, I want a history screen with my past sessions and weekly totals, so that I
can track progress at a glance.

#### Acceptance Criteria

1. THE History_View SHALL list Workout_Sessions ordered by end timestamp, newest first.
2. THE History_View SHALL display, for each listed Workout_Session, the end date, a Workout_Type
   badge, the completed round count and planned round count, the total duration formatted as `mm:ss`
   or `h:mm:ss`, and the stored workout name.
3. THE History_View SHALL display aggregate values for the current calendar week: number of
   Workout_Sessions, sum of completed rounds, and sum of total durations.
4. THE History_View SHALL compute each aggregate value in acceptance criterion 7.3 as the exact sum
   over the Workout_Sessions whose end timestamps fall within the current calendar week.
5. IF no Workout_Session records are available, THEN THE History_View SHALL display an empty state
   inviting the user to complete a workout.
6. IF loading Workout_Sessions fails, THEN THE History_View SHALL display an error state with a retry
   control and keep any locally available Workout_Sessions visible.
7. THE History_View SHALL display each Workout_Session's completed flag so that stopped and finished
   workouts are visually distinguishable.

---

### Requirement 8: Cross-Device History and Workout Synchronization

**User Story:** As a user who saves a workout on my phone, I want that workout and my history to
appear on my computer, so that my data follows my account instead of being stranded in one browser's
local storage.

#### Acceptance Criteria

1. WHILE no Authenticated_Session exists, THE Workout_Repository SHALL read and write Workouts and
   Workout_Sessions using browser storage only, in Local_Only_Mode.
2. WHILE an Authenticated_Session exists, THE Workout_Repository SHALL write each Workout and
   Workout_Session to browser storage first and then send the same record to the Workouts_API or
   Sessions_API respectively.
3. WHEN a user with an Authenticated_Session opens the application on a device whose browser storage
   holds no records for that user, THE Workout_Repository SHALL fetch that user's Workouts and
   Workout_Sessions from the server and THE Workout_Builder and History_View SHALL display the
   fetched records.
4. WHEN a user signs in on a device whose browser storage holds records that are absent from the
   server, THE Workout_Repository SHALL send those records to the server and mark them as
   synchronized.
5. WHEN the same Workout or Workout_Session record is sent to the server more than once, THE
   Workouts_API and Sessions_API SHALL store exactly one row for that record's client-generated
   identifier.
6. THE Workouts_API and Sessions_API SHALL restrict every read and every write to rows whose `userId`
   matches the `userId` of the Authenticated_Session.
7. IF a request to the Workouts_API or Sessions_API carries no Authenticated_Session, THEN THE
   receiving route handler SHALL respond with HTTP status 401.
8. IF a request body sent to the Workouts_API or Sessions_API fails schema validation, THEN THE
   receiving route handler SHALL respond with HTTP status 400 and a body naming each invalid field.
9. IF `DATABASE_URL` is unset or the database is unreachable, THEN THE Workouts_API and Sessions_API
   SHALL respond with HTTP status 503.
10. IF the Workouts_API or Sessions_API is unreachable or responds with HTTP status 503, THEN THE
    Workout_Repository SHALL continue serving the application from browser storage, display an
    unsynchronized-data indicator, and retry sending pending records on the next successful request.
11. WHEN a user signs out, THE Workout_Repository SHALL return to Local_Only_Mode and serve
    subsequent reads from browser storage.

---

### Requirement 9: Red-and-White Theme Driven by Design Tokens

**User Story:** As a user, I want a bold red-and-white interface, so that the app looks like a boxing
app and its accent color is consistent everywhere instead of purple tokens fighting hard-coded red
utilities.

#### Acceptance Criteria

1. THE Theme_System SHALL define `--primary` as a hue within the red range of 0 to 14 degrees in both
   the `:root` block and the `.dark` block of `app/globals.css`.
2. THE Theme_System SHALL define `--ring` with the same value as `--primary` in both the `:root` block
   and the `.dark` block.
3. THE Theme_System SHALL define `--chart-1` through `--chart-5` using hues within the red,
   red-orange, and red-pink ranges in both the `:root` block and the `.dark` block.
4. THE Theme_System SHALL define the `.hero-gradient` and `.dark .hero-gradient` utilities using
   red-family colors only.
5. WHILE light mode is active, THE Theme_System SHALL define `--background` and `--card` as white
   (`0 0% 100%`).
6. WHILE dark mode is active, THE Theme_System SHALL define `--foreground` as white or near-white so
   that foreground text on `--background` reaches a contrast ratio of at least 4.5 to 1.
7. THE Timer_View SHALL express every brand accent using semantic token utilities derived from
   `--primary`, such that the file `app/_components/boxing-timer.tsx` contains zero occurrences of
   the `red-500` and `red-600` Tailwind utilities.
8. THE Timer_View SHALL render the Start and Resume control using the default `Button` variant so that
   the control inherits `bg-primary` and `text-primary-foreground`.
9. THE Theme_System SHALL define `--primary-foreground` such that its contrast ratio against
   `--primary` is at least 4.5 to 1 in both light mode and dark mode.
10. WHERE red text is rendered at a font size below 18 pixels on a `--background` surface, THE
    Timer_View SHALL use `--accent-foreground` or `--foreground` so that the text reaches a contrast
    ratio of at least 4.5 to 1.
11. THE Timer_View SHALL assign a distinct accent color to each of the `prep`, `round`, `rest`, and
    `finished` Phases, and SHALL assign the `rest` Phase an accent whose hue differs from the `round`
    Phase accent hue by at least 90 degrees.
12. THE Timer_View SHALL render the `round` Phase progress ring using `stroke-primary`.
13. THE Theme_System SHALL keep the existing Tailwind token mappings in `tailwind.config.ts`
    unchanged, so that `bg-primary`, `text-primary`, `stroke-primary`, and `ring-primary` resolve to
    the red palette.
14. WHEN the user toggles between light mode and dark mode, THE Theme_System SHALL resolve all colors
    from the corresponding token block without component-level color branching.

---

### Requirement 10: Mobile-First Layout, Navigation, and Accessibility

**User Story:** As a user operating the app mid-workout with sweaty hands on a phone, I want big
targets, a large readable countdown, and clear navigation between the timer, builder, and history, so
that I can control the app in one glance and one thumb.

#### Acceptance Criteria

1. THE Timer_View SHALL present a top-level tab navigation with the tabs Timer, Builder, and History.
2. WHEN the user activates a tab, THE Timer_View SHALL render the corresponding panel and style the
   active tab trigger using `--primary`.
3. THE Timer_View SHALL render the Start, Pause, and Stop controls with a touch target of at least
   44 by 44 CSS pixels each.
4. WHILE the viewport width is below 640 CSS pixels, THE Timer_View SHALL render the primary action
   control at full container width and positioned above the secondary controls.
5. THE Timer_View SHALL render the countdown using a monospaced font with tabular numerals, and SHALL
   render it at a larger font size when the viewport width is at least 1024 CSS pixels than when it
   is below 640 CSS pixels.
6. THE Timer_View, Workout_Builder, History_View, and Sound_Settings_View SHALL render a visible focus
   indicator derived from `--ring` on every keyboard-focusable element.
7. WHERE the user agent reports `prefers-reduced-motion: reduce`, THE Timer_View, Workout_Builder,
   History_View, and Sound_Settings_View SHALL either omit animated transitions or limit each
   transition duration to at most 10 milliseconds.
8. THE Workout_Builder, History_View, and Sound_Settings_View SHALL provide an accessible name for
   every interactive control, through a visible label or an `aria-label` attribute.
9. WHERE the viewport width is below 640 CSS pixels, THE Timer_View SHALL present timer settings in a
   bottom-sheet drawer rather than a side panel.
10. THE Workout_Builder, History_View, and Sound_Settings_View SHALL express all colors through
    Theme_System tokens.
11. WHEN a workout completes or a Workout is saved, THE Timer_View SHALL display a transient toast
    confirmation.

---

### Requirement 11: Installable Progressive Web App

**User Story:** As a user, I want to install the timer on my iPhone home screen and launch it like an
app, so that it opens full screen without browser chrome and starts even with no connection.

#### Acceptance Criteria

1. THE PWA_Shell SHALL serve a web app manifest at `/manifest.webmanifest` declaring `name`,
   `short_name` of "Boxing Timer", `start_url` of "/", `display` of "standalone", `orientation` of
   "portrait", `theme_color`, `background_color`, and icon entries for 192×192, 512×512, and a
   512×512 maskable icon.
2. THE PWA_Shell SHALL emit document metadata linking the manifest and setting
   `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-touch-icon`, and
   `theme-color`.
3. WHEN the application is launched from an installed home-screen icon, THE PWA_Shell SHALL render in
   standalone display mode without browser navigation chrome.
4. WHEN the Service_Worker installs, THE Service_Worker SHALL cache the application shell assets and
   the bundled audio assets under `public/sounds/`.
5. WHILE the device has no network connection, THE Service_Worker SHALL serve the timer screen from
   cache so that the Timer_Engine, Sound_Engine, and locally stored Workouts remain usable.
6. THE Service_Worker SHALL attempt the network first for requests to paths beginning with `/api/`.
7. IF a request to a path beginning with `/api/` fails, THEN THE Service_Worker SHALL propagate the
   failure to the client so that the Workout_Repository applies its Local_Only_Mode fallback.
8. WHERE the user agent supports the `beforeinstallprompt` event, THE PWA_Shell SHALL display an
   install control that triggers the browser install prompt.
9. WHERE the user agent is iOS Safari and the application is not running in standalone display mode,
   THE PWA_Shell SHALL display a dismissible hint describing the Share then "Add to Home Screen"
   steps, and SHALL display that hint at most once per browser profile after dismissal.
10. THE PWA_Shell SHALL declare a manifest `theme_color` equal to the resolved `--primary` red value
    defined by the Theme_System.
11. WHEN a new Service_Worker version is available, THE PWA_Shell SHALL activate it on the next
    application launch.

---

### Requirement 12: Deployment Readiness for Database-Backed Features

**User Story:** As the operator of the already-deployed Railway service, I want the new database-backed
history and sync features to deploy safely, so that schema changes are applied automatically and a
bad migration never takes the live app down.

#### Acceptance Criteria

1. THE repository SHALL contain committed Prisma migration files defining the `User`, `Account`,
   `Session`, `VerificationToken`, `Workout`, and `WorkoutSession` models.
2. WHEN a deploy runs, THE Deployment_Pipeline SHALL execute `prisma migrate deploy` in the release
   phase, after the build step completes and before the new instance receives traffic.
3. IF the release-phase migration command exits with a non-zero status, THEN THE Deployment_Pipeline
   SHALL abort the deploy and leave the previously deployed version serving traffic.
4. WHEN the release-phase migration command runs against a database whose migrations are already
   applied, THE Deployment_Pipeline SHALL complete the step without altering the schema.
5. THE Deployment_Pipeline SHALL read the database connection string from the `DATABASE_URL`
   environment variable.
6. THE build script SHALL execute `prisma generate` before `next build`.
7. THE start script SHALL bind the server to the port supplied in the `PORT` environment variable.
8. THE Deployment_Pipeline SHALL pin the Node.js runtime to major version 20.
9. WHERE optional accounts are enabled, THE Deployment_Pipeline SHALL require the `NEXTAUTH_URL` and
   `NEXTAUTH_SECRET` environment variables to be present.
10. IF `DATABASE_URL` is absent at runtime, THEN THE application SHALL start successfully and operate
    in Local_Only_Mode.
11. THE Deployment_Pipeline SHALL expose a healthcheck path that returns HTTP status 200 when the
    server is ready to serve requests.

---

### Requirement 13: Removal of Unrelated Dead Code

**User Story:** As a developer maintaining this codebase, I want the leftover expenses boilerplate
removed, so that `lib/types.ts` describes the timer domain and nothing else.

#### Acceptance Criteria

1. THE `lib/types.ts` module SHALL export only types belonging to the timer domain, such as
   `WorkoutType`, workout data-transfer types, and Workout_Session data-transfer types.
2. THE codebase SHALL contain zero references to the identifiers `Expense`, `ExpenseFormData`,
   `EXPENSE_CATEGORIES`, and `DateRange`.
3. WHEN the TypeScript type check and the production build run after the cleanup, THE build SHALL
   complete with zero errors.

---

## Out of Scope

The following are explicitly excluded from this feature set. No requirements are defined for them.

1. **Native iOS Dynamic Island and Live Activity support, and true background execution.** The web
   platform exposes no API for Live Activities, the Dynamic Island, or guaranteed background
   execution, and iOS suspends JavaScript timers and the AudioContext for backgrounded or locked
   tabs — including installed PWAs. Delivering this would require wrapping the application with
   Capacitor (or React Native) and implementing a native Swift plugin using ActivityKit, plus native
   background modes for lock-screen audio and App Store distribution. This is deferred to a separate
   native spec. Requirement 1 keeps the timer *correct on resume*; it does not make the timer *run*
   while backgrounded, and Requirement 4 documents that limitation to the user.
2. **The Next.js major-version upgrade.** The application remains on Next.js 14.2 App Router for this
   feature set.

---

## Traceability

The design document's correctness properties **P1–P8** validate the following acceptance criteria:

| Design property | Validates |
|-----------------|-----------|
| P1 — Elapsed monotonicity | 1.3 |
| P2 — Pause freezes the clock | 1.4, 1.7, 6.3 |
| P3 — Background resilience (no drift) | 1.1, 1.2, 1.6 |
| P4 — Plan totals | 2.1, 2.2, 2.3, 2.4, 2.5, 2.6 |
| P5 — Phase-transition correctness | 2.7 |
| P6 — Boundary landing | 2.8, 2.9 |
| P7 — Clamp safety | 1.9, 1.10 |
| P8 — Catch-up sound discipline | 2.10, 4.4 |

Acceptance criteria outside the P1–P8 timer-engine contract are verified by the unit, integration,
and smoke tests described in the design's Testing Strategy. Requirements 9, 12, and 13 are verified
by deterministic token, configuration, and build assertions rather than property-based tests.
