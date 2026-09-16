import type { Metadata, Viewport } from 'next'
import { DM_Sans, Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { ChunkLoadErrorHandler } from '@/components/chunk-load-error-handler'
import { InstallPrompt } from '@/components/pwa/install-prompt'
import { ServiceWorkerRegistrar } from '@/components/pwa/service-worker-registrar'

export const dynamic = 'force-dynamic'

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-sans' })
const jakartaSans = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-display' })
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' })

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXTAUTH_URL ?? 'http://localhost:3000'),
  title: 'Boxing Rounds Timer',
  description: 'A minimalist boxing rounds timer with customizable rounds, rests, audio cues, and preset management.',
  applicationName: 'Boxing Timer',
  /**
   * Requirement 11.2: link the manifest so the browser can offer installation, and declare
   * the Apple-specific metadata that makes an iOS home-screen launch open standalone rather
   * than in a Safari tab with visible navigation chrome (requirement 11.3).
   */
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    // Emits `<meta name="apple-mobile-web-app-capable" content="yes">`.
    capable: true,
    title: 'Boxing Timer',
    // The status bar blends into the dark app background instead of drawing a light band.
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
    // `<link rel="apple-touch-icon">` — the home-screen artwork on iOS.
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  openGraph: {
    title: 'Boxing Rounds Timer',
    description: 'Customizable rounds, rests, audio cues, and saved presets — all in your browser.',
    images: ['/og-image.png'],
  },
}

/**
 * Requirement 11.2: `theme-color` tints the iOS/Android system bars with the app's own red.
 * It is the resolved `--primary` from `app/globals.css` and matches the manifest's
 * `theme_color` (requirement 11.10) — `app/pwa-assets.test.ts` keeps the three in lockstep.
 *
 * `viewportFit: 'cover'` lets the standalone window paint under the notch and the home
 * indicator; `components/pwa/install-prompt.tsx` keeps itself clear of them with
 * `env(safe-area-inset-bottom)`.
 * The timer is a full-screen control surface, so pinch-zoom is left enabled (requirement
 * 10.3 wants large targets, not a locked viewport).
 */
export const viewport: Viewport = {
  themeColor: '#ed2c2c',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script src="https://apps.abacus.ai/chatllm/appllm-lib.js"></script>
      </head>
      <body className={`${dmSans.variable} ${jakartaSans.variable} ${jetbrainsMono.variable} font-sans`}>
        {/* defaultTheme follows the OS; ThemeToggle in the header overrides it. */}
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
          {/* Requirements 11.4–11.7, 11.11: offline shell. Registers `public/sw.js` on mount. */}
          <ServiceWorkerRegistrar />
          {/* Requirements 11.8, 11.9: the install button and the iOS add-to-home-screen hint. */}
          <InstallPrompt />
          {/* IMPORTANT: Do not remove — handles chunk loading race conditions in the dev server */}
          <ChunkLoadErrorHandler />
        </ThemeProvider>
      </body>
    </html>
  )
}
