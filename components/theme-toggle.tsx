'use client'

/**
 * The light / dark switch.
 *
 * `app/globals.css` has carried a complete light (`:root`) and dark (`.dark`) token set from
 * the start, but this control was never mounted anywhere and the layout hard-coded
 * `defaultTheme="dark"` — so the light palette was unreachable. It is mounted in the
 * `boxing-app.tsx` header alongside the mute and Sounds controls.
 *
 * Both icons are always rendered and swapped with `dark:` variants rather than branched on the
 * value of `useTheme()`. That is deliberate: `theme` is `undefined` on the server and on the
 * first client render, so branching on it would produce a hydration mismatch and a visible
 * icon flip. CSS resolves from the `class` on `<html>`, which is correct immediately.
 *
 * `resolvedTheme` (not `theme`) decides the next value, so the first click from the
 * system-following default goes to the opposite of what the user is actually looking at
 * instead of to whatever `system` happens to equal.
 */

import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import { Button } from '@/components/ui/button'

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()

  // `resolvedTheme` is undefined until mounted; the layout defaults to dark, so assume dark.
  const isDark = resolvedTheme !== 'light'
  const nextLabel = isDark ? 'Switch to light mode' : 'Switch to dark mode'

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={nextLabel}
      title={nextLabel}
      className="relative min-h-[44px] min-w-[44px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none"
    >
      <Sun className="h-4 w-4 rotate-0 scale-100 transition-all duration-200 motion-reduce:transition-none dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all duration-200 motion-reduce:transition-none dark:rotate-0 dark:scale-100" />
    </Button>
  )
}
