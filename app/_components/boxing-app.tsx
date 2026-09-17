'use client'

/**
 * The application shell: the page chrome and the top-level tab navigation.
 *
 * Three views existed before this component but only the timer was reachable. This adds the
 * Timer / Builder / History tabs required by requirement 10.1, styles the active trigger from
 * `--primary` (requirement 10.2), and moves the header — brand, mute toggle and sound settings
 * — out of the timer panel so `boxing-timer.tsx` is only the timer.
 *
 * **The timer panel stays mounted.** Radix unmounts an inactive `TabsContent`, which for a
 * running workout would mean losing the run the moment the user glanced at their history. The
 * timer therefore uses `forceMount` with an explicit `hidden`, so switching tabs hides it
 * without tearing down the engine, its pre-scheduled boundary sounds or its session recording.
 * Builder and History mount on demand, which is also what makes History re-read its sessions
 * every time it is opened.
 *
 * **Sound settings adapt to the viewport** (requirement 10.2): a `Dialog` at 640 px and up,
 * a bottom-sheet `Drawer` below it. Only one of the two is mounted at a time, so no control's
 * accessible name is duplicated in the accessibility tree.
 *
 * **The workout list is shared.** Both the timer panel and the builder read and write
 * `lib/data/workoutLibrary.ts`, so a workout saved in the Builder is immediately available in
 * the Timer's preset list and neither view can clobber the other's writes. Saving in the
 * builder also jumps back to the timer, because saving a workout is something a user does in
 * order to *use* it.
 *
 * **Sync settings follow the same pattern.** Device pairing is a device setting, not a workout
 * surface, so it lives beside Sounds in the header rather than becoming a fourth tab — the tab
 * count stays at exactly three (requirements 12.1, 12.2, 12.3).
 *
 * **The chrome pays back the safe-area insets.** `viewportFit: 'cover'` in `app/layout.tsx`
 * lets the window paint under the notch and the home indicator, which means anything pinned to
 * an edge must add the inset back itself — see the `pt-safe` / `px-safe` note on the header.
 *
 * **The introductory copy is idle-only.** The timer reports when a workout is on screen and
 * the hero and the footer tip step out of the way; neither is worth any of a 390 px-wide
 * viewport once the user is mid-round.
 *
 * Requirements: 10.1, 10.2, 10.6, 10.7, 10.8, 10.11, 12.1, 12.2, 12.3, 12.18
 */

import { useCallback, useState } from 'react'
import {
  Bell,
  Hammer,
  History,
  RefreshCw,
  SlidersHorizontal,
  Timer,
  Volume2,
  VolumeX,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ThemeToggle } from '@/components/theme-toggle'
import BoxingTimer from '@/app/_components/boxing-timer'
import HistoryView from '@/app/_components/history-view'
import SoundSettings from '@/app/_components/sound-settings'
import SyncSettings from '@/app/_components/sync-settings'
import WorkoutBuilder from '@/app/_components/workout-builder'
import { useSoundSettings } from '@/lib/audio/useSoundSettings'
import { useIsMobileViewport } from '@/lib/ui/useMediaQuery'

/** The three top-level views (requirement 10.1). */
type AppTab = 'timer' | 'builder' | 'history'

const TABS: ReadonlyArray<{ value: AppTab; label: string; icon: typeof Timer }> = [
  { value: 'timer', label: 'Timer', icon: Timer },
  { value: 'builder', label: 'Builder', icon: Hammer },
  { value: 'history', label: 'History', icon: History },
]

/**
 * The active trigger's styling (requirement 10.2). `data-[state=active]` resolves through
 * `--primary`, overriding the stock trigger's neutral `data-[state=active]:bg-background`.
 * The `focus-visible` ring comes from `--ring` (requirement 10.6), and the 44 px minimum height
 * keeps the triggers thumb-sized on a phone.
 */
const TAB_TRIGGER_CLASS =
  'flex-1 min-h-[44px] gap-1.5 text-xs sm:text-sm data-[state=active]:bg-primary ' +
  'data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'motion-reduce:transition-none'

export default function BoxingApp() {
  const [tab, setTab] = useState<AppTab>('timer')
  const [soundSettingsOpen, setSoundSettingsOpen] = useState<boolean>(false)
  /**
   * True from the moment a workout starts until the timer is back to idle. The timer reports
   * it (see `BoxingTimerProps.onActivityChange`); the shell uses it to withdraw its own
   * introductory copy, which has no value once the user is mid-round.
   */
  const [workoutEngaged, setWorkoutEngaged] = useState<boolean>(false)
  const [syncSettingsOpen, setSyncSettingsOpen] = useState<boolean>(false)
  const { muted, toggleMuted } = useSoundSettings()
  const isMobile = useIsMobileViewport()

  /** A workout saved in the Builder is one the user wants to run, so hand them the timer. */
  const handleWorkoutSaved = useCallback(() => {
    setTab('timer')
  }, [])

  const soundSettingsTrigger = (
    <Button variant="ghost" size="sm" className="gap-2 min-h-[44px]" aria-label="Sound settings">
      <SlidersHorizontal className="w-4 h-4" aria-hidden="true" />
      <span className="hidden sm:inline text-xs">Sounds</span>
    </Button>
  )

  const soundSettingsBlurb =
    'Pick a sound for each moment of the workout, upload your own bell, and set the volume.'

  /**
   * The Sync trigger sits beside Sounds because sync is a *device setting*, the category the
   * header already owns — the three tabs are workout surfaces, and a fourth would push each
   * trigger under a comfortable thumb width on a 360 px viewport (requirements 12.1, 12.3).
   */
  const syncSettingsTrigger = (
    <Button variant="ghost" size="sm" className="gap-2 min-h-[44px]" aria-label="Sync devices">
      <RefreshCw className="w-4 h-4" aria-hidden="true" />
      <span className="hidden sm:inline text-xs">Sync</span>
    </Button>
  )

  const syncSettingsBlurb =
    'Pair another device with a short code, see what is paired, and start over if you need to.'

  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      {/*
        `pt-safe` / `px-safe` (app/globals.css) pay back the insets that `viewportFit: 'cover'`
        in app/layout.tsx deliberately paints under. Without them, on any notched iPhone this
        sticky header started at y=0 *behind* the status bar: the title overlapped the system
        clock and the right-hand controls — theme, mute, Sounds, Sync — sat under the Dynamic
        Island, which made sound settings and device pairing unreachable on the exact device
        the app is used on. They are padding, so the row below keeps its full 56 px height
        rather than being squeezed; `px-safe` covers the landscape insets.
      */}
      <header className="sticky top-0 z-30 w-full backdrop-blur bg-background/70 border-b border-border/40 pt-safe px-safe">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 h-14 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Bell className="w-4 h-4 text-primary" aria-hidden="true" />
            </div>
            <span className="font-display font-semibold tracking-tight truncate">
              Boxing Timer
            </span>
          </div>

          {/* gap-1 below 640 px: four icon-only controls plus the brand have to clear 44 px
              each inside 390 px, and gap-2 was the difference. */}
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            {/* Light / dark switch. The light token set was previously unreachable. */}
            <ThemeToggle />

            <Button
              variant="ghost"
              size="sm"
              onClick={toggleMuted}
              aria-label={muted ? 'Unmute' : 'Mute'}
              className="gap-2 min-h-[44px]"
            >
              {muted ? (
                <VolumeX className="w-4 h-4" aria-hidden="true" />
              ) : (
                <Volume2 className="w-4 h-4" aria-hidden="true" />
              )}
              <span className="hidden sm:inline text-xs">{muted ? 'Muted' : 'Sound On'}</span>
            </Button>

            {/* Requirement 10.2: a drawer on phones, a dialog from 640 px up. */}
            {isMobile ? (
              <Drawer open={soundSettingsOpen} onOpenChange={setSoundSettingsOpen}>
                <DrawerTrigger asChild>{soundSettingsTrigger}</DrawerTrigger>
                <DrawerContent className="max-h-[85vh]">
                  <DrawerHeader>
                    <DrawerTitle>Sounds</DrawerTitle>
                    <DrawerDescription>{soundSettingsBlurb}</DrawerDescription>
                  </DrawerHeader>
                  <div className="overflow-y-auto px-4 pb-8">
                    <SoundSettings />
                  </div>
                </DrawerContent>
              </Drawer>
            ) : (
              <Dialog open={soundSettingsOpen} onOpenChange={setSoundSettingsOpen}>
                <DialogTrigger asChild>{soundSettingsTrigger}</DialogTrigger>
                <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Sounds</DialogTitle>
                    <DialogDescription>{soundSettingsBlurb}</DialogDescription>
                  </DialogHeader>
                  <SoundSettings />
                </DialogContent>
              </Dialog>
            )}

            {/*
              Requirements 12.1, 12.2, 12.18: the Sounds pattern verbatim — a drawer below
              640 px, a dialog from 640 px up, and exactly one of the two mounted at any width
              so "Sync devices" never appears twice in the accessibility tree.
            */}
            {isMobile ? (
              <Drawer open={syncSettingsOpen} onOpenChange={setSyncSettingsOpen}>
                <DrawerTrigger asChild>{syncSettingsTrigger}</DrawerTrigger>
                <DrawerContent className="max-h-[85vh]">
                  <DrawerHeader>
                    <DrawerTitle>Sync</DrawerTitle>
                    <DrawerDescription>{syncSettingsBlurb}</DrawerDescription>
                  </DrawerHeader>
                  <div className="overflow-y-auto px-4 pb-8">
                    <SyncSettings />
                  </div>
                </DrawerContent>
              </Drawer>
            ) : (
              <Dialog open={syncSettingsOpen} onOpenChange={setSyncSettingsOpen}>
                <DialogTrigger asChild>{syncSettingsTrigger}</DialogTrigger>
                <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Sync</DialogTitle>
                    <DialogDescription>{syncSettingsBlurb}</DialogDescription>
                  </DialogHeader>
                  <SyncSettings />
                </DialogContent>
              </Dialog>
            )}
          </div>
        </div>
      </header>

      {/*
        The safe-area padding is on `main` and the layout padding on the div inside it, never
        both on one element: `px-safe` and `px-4` set the same CSS property, so on a device with
        no insets whichever Tailwind emitted last would win and the other would vanish.
      */}
      <main className="px-safe pb-safe">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-4 sm:py-10">
          {/*
            The hero is a first-visit introduction, so it is shown only while nothing is running.
            Mid-workout it is ~110 px of a 390 px-wide phone spent on copy the user has already
            read, directly above the two numbers they are actually looking for.
          */}
          {!workoutEngaged && (
            <div className="text-center mb-5 sm:mb-8">
              <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight">
                Train by the <span className="text-primary">bell</span>.
              </h1>
              <p className="mt-2 text-sm sm:text-base text-muted-foreground">
                Configure rounds and rests, build your own workouts, and keep every session.
              </p>
            </div>
          )}

          <Tabs value={tab} onValueChange={(next) => setTab(next as AppTab)}>
            <TabsList aria-label="Sections" className="mb-4 flex h-auto w-full gap-1 p-1">
              {TABS.map(({ value, label, icon: Icon }) => (
                <TabsTrigger key={value} value={value} className={TAB_TRIGGER_CLASS}>
                  <Icon className="w-4 h-4" aria-hidden="true" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>

            {/*
              `forceMount` with an explicit `hidden` keeps the running timer — and the sounds it
              has pre-scheduled on the audio clock — alive while another tab is on screen. The
              explicit `hidden` is required: `forceMount` alone would leave the panel visible.
            */}
            <TabsContent value="timer" forceMount hidden={tab !== 'timer'} className="mt-0">
              <BoxingTimer onActivityChange={setWorkoutEngaged} />
            </TabsContent>

            <TabsContent value="builder" className="mt-0">
              <div className="mx-auto max-w-2xl">
                <WorkoutBuilder onSaved={handleWorkoutSaved} />
              </div>
            </TabsContent>

            <TabsContent value="history" className="mt-0">
              <div className="mx-auto max-w-2xl">
                <HistoryView />
              </div>
            </TabsContent>
          </Tabs>

          {/* Same reasoning as the hero: a first-run tip, not workout furniture. */}
          {!workoutEngaged && (
            <footer className="mt-8 text-center text-xs text-muted-foreground">
              <p>
                Tip: audio unlocks after you press Start. The countdown stays accurate even if you
                switch apps.
              </p>
            </footer>
          )}
        </div>
      </main>
    </div>
  )
}
