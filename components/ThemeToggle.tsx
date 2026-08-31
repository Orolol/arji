"use client";

import { useTheme } from "next-themes";
import { Sun, Moon } from "lucide-react";
import { useSyncExternalStore } from "react";

// `next-themes` only knows the real theme on the client, so the first paint has
// to match the server HTML. `useSyncExternalStore` gives that hydration guard
// directly — false from the server snapshot, true on the client — without the
// mount effect that used to set state on every mount.
const subscribeToNothing = () => () => {};
const isClient = () => true;
const isServer = () => false;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribeToNothing, isClient, isServer);

  if (!mounted) return <div className="w-[34px] h-[34px]" />;

  return (
    <button
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="flex items-center justify-center w-[34px] h-[34px] rounded-[9px] hover:bg-sidebar-accent text-muted-foreground hover:text-foreground transition-colors"
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? (
        <Sun className="h-5 w-5" />
      ) : (
        <Moon className="h-5 w-5" />
      )}
    </button>
  );
}
