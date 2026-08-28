"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The id the redesigned project layout is expected to expose for page actions. */
export const PROJECT_HEADER_ACTIONS_ID = "project-header-actions";

interface HeaderActionSlotProps {
  /** Re-query the host node when the project changes (the layout remounts). */
  projectId?: string;
  children: ReactNode;
}

/**
 * Portals a page-level action into the project layout's header, when the
 * layout offers a slot for it — and renders it inline when it does not.
 *
 * Frame 8b draws "Régénérer par chat" in the 60px project header, but that
 * header belongs to `app/projects/[projectId]/layout.tsx`, which this packet
 * does not own. So: look for `#project-header-actions` after mount; portal
 * into it when present, otherwise render in place (the caller puts the
 * fallback at the right end of the SPEC band header).
 *
 * `document` is never read during render — the first client render matches the
 * server render (inline), and the portal only takes over after the effect, so
 * there is no hydration mismatch. The node is allowed to appear late: the
 * layout mounts around this page, so a second look on the next tick catches a
 * header that hydrates after the page body.
 */
export function HeaderActionSlot({ projectId, children }: HeaderActionSlotProps) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const look = () => setHost(document.getElementById(PROJECT_HEADER_ACTIONS_ID));
    look();
    const retry = setTimeout(look, 0);
    return () => clearTimeout(retry);
  }, [projectId]);

  if (host) return createPortal(children, host);
  return <>{children}</>;
}
