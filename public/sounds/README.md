# Bundled sounds

This directory is where the app looks for the bundled sound assets registered in
[`lib/audio/builtins.ts`](../../lib/audio/builtins.ts):

| Asset path                 | Display name             | Intended character  |
| -------------------------- | ------------------------ | ------------------- |
| `/sounds/boxing-bell.mp3`  | Boxing bell (bundled)    | Ringside bell       |
| `/sounds/air-horn.mp3`     | Air horn (bundled)       | End-of-fight horn   |
| `/sounds/buzzer.mp3`       | Buzzer (bundled)         | Low double buzzer   |
| `/sounds/beep.mp3`         | Beep (bundled)           | Short mid-range cue |

## What this repository actually bundles

**No third-party audio files are committed to this repository.** None were downloaded, and
none are redistributed here — so there is no third-party licence, attribution, or
royalty obligation attached to this directory today.

The registry above is still wired up end to end. `lib/audio/soundEngine.ts` fetches an
asset lazily the first time a role assigned to it plays, and when the fetch or the decode
fails — which is exactly what happens while these files are absent — it plays the
**synthesized tone associated with that role** instead (requirement 3.7). The synth tones
in [`lib/audio.ts`](../../lib/audio.ts) are generated from oscillators at runtime: they
need no files, work offline, and are the app's default assignment for all four roles.

The practical consequence: selecting a bundled asset never breaks playback or the timer.
It sounds like the role's synth tone until a real file is dropped in.

## Adding real assets later

To ship actual audio:

1. Obtain files under a licence that permits redistribution — public domain / CC0, or a
   commercial licence covering this use.
2. Save them at exactly the paths in the table above (`.mp3`, mono or stereo, ≤ ~200 KB
   each keeps the install-time service-worker cache small).
3. Record the provenance of each file in the table below — source URL, author, licence,
   and any required attribution text. Do not commit a file whose licence you cannot state.

| File | Source | Author | Licence | Attribution required |
| ---- | ------ | ------ | ------- | -------------------- |
| _(none bundled yet)_ | — | — | — | — |

No other change is needed: the registry, the settings selector, the service-worker cache
list, and the fallback chain already reference these paths.

## Users can always bring their own

Uploading a custom sound does not depend on this directory at all. The sound settings view
accepts any `audio/*` file up to 5 MB and 10 seconds, stores it in IndexedDB, and can
assign it to any of the four roles (requirements 3.4, 3.5) — so a user who wants a specific
bell can supply it without this repository redistributing anything.
