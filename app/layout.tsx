import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Sans, Space_Mono } from "next/font/google";
import "./globals.css";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TopBar } from "@/components/piscine";

/* Piscine typography. next/font/google self-hosts these at build time — no
   runtime request to Google — and each `variable` is bridged to a Tailwind
   font namespace in app/globals.css (--font-sans / --font-mono / --font-display).
   If a build host is offline, vendor the three families' .woff2 into app/fonts/
   and swap to next/font/local under identical variable names; nothing else changes. */

/* Titles, strata labels. Variable 200-800; the design uses 500/600/700. */
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-bricolage",
  display: "swap",
});

/* UI text — the body face. Variable 400-700; the design uses 400/500/600. */
const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-instrument",
  display: "swap",
});

/* Ids, chronos, stamps, counters, logs. NON-VARIABLE: `weight` is required and
   only 400/700 exist, so font-medium/font-semibold on a mono element now
   synthesises a faux weight (Geist Mono was 100-900). Both real weights loaded. */
const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-space-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Arij",
  description: "AI-first project orchestrator powered by Claude Code",
  icons: {
    icon: [
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/icons/favicon-64.png", sizes: "64x64", type: "image/png" },
      { url: "/icons/favicon-128.png", sizes: "128x128", type: "image/png" },
      { url: "/icons/favicon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/favicon-512.png", sizes: "512x512", type: "image/png" },
      { url: "/icons/favicon.svg", type: "image/svg+xml" },
    ],
    shortcut: "/icons/favicon.ico",
    apple: "/icons/apple-touch-icon.png",
  },
  manifest: "/manifest.json",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  /* The locale `lib/i18n/request.ts` resolved for this request: the stored
     `ui_locale` setting, else the browser language. `<html lang>` follows it
     so assistive tech and hyphenation read the chrome in the language it is
     actually drawn in. */
  const locale = await getLocale();

  return (
    <html lang={locale} suppressHydrationWarning>
      <body
        className={`${bricolage.variable} ${instrumentSans.variable} ${spaceMono.variable} antialiased`}
      >
        {/*
          Rendered from a server component, so it inherits the request's
          locale and messages from lib/i18n/request.ts — nothing is passed
          by hand. Every `useTranslations` / `useLocale` below the bar reads
          from here.
        */}
        <NextIntlClientProvider>
        <ThemeProvider>
          <TooltipProvider>
            {/*
              Frame 13a: ONE global bar, on every route, above a single scroll
              container. It replaces the left rail (retired) and, once the
              retrofit pass strips them, the 60px header each screen still
              draws for itself. `min-h-0` is what lets `main` scroll instead of
              growing the column past the viewport.
            */}
            <div className="flex h-screen flex-col">
              <TopBar />
              <main className="flex-1 min-h-0 min-w-0 overflow-auto">{children}</main>
            </div>
          </TooltipProvider>
        </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
