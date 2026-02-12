import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import Link from "next/link";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LayoutDashboard, Settings, FolderKanban } from "lucide-react";
import { ThemeProvider } from "@/components/ThemeProvider";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AgentConfigButton } from "@/components/agent-config/AgentConfigButton";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
});

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Arij",
  description: "AI-first project orchestrator powered by Claude Code",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider>
          <TooltipProvider>
            <div className="flex h-screen">
              <aside className="w-16 border-r border-border bg-sidebar flex flex-col items-center py-4 gap-4">
                <Link
                  href="/"
                  className="flex items-center justify-center w-10 h-10 rounded-lg font-bold text-lg text-primary"
                >
                  <FolderKanban className="h-6 w-6" />
                </Link>
                <div className="flex-1 flex flex-col items-center gap-2 mt-4">
                  <Link
                    href="/"
                    className="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-sidebar-accent text-sidebar-foreground transition-colors"
                    title="Dashboard"
                  >
                    <LayoutDashboard className="h-5 w-5" />
                  </Link>
                </div>
                <AgentConfigButton />
                <ThemeToggle />
                <Link
                  href="/settings"
                  className="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-sidebar-accent text-sidebar-foreground transition-colors"
                  title="Settings"
                >
                  <Settings className="h-5 w-5" />
                </Link>
              </aside>
              <main className="flex-1 overflow-auto">{children}</main>
            </div>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
