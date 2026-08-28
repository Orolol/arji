"use client";

/**
 * TicketOverlayProvider — STUB.
 *
 * Frame 6a (the ticket overlay) is a separate packet. This file exists so the
 * desk has a real, typed way to say "open this ticket" today, and so that
 * packet can replace the panel wholesale without touching a single call site.
 *
 * THE CONTRACT — this is the part that must not change:
 *
 *   const { openTicket, closeTicket, ticketId } = useTicketOverlay();
 *   openTicket(epicId, { projectId })   // opens
 *   closeTicket()                       // closes; Escape does too
 *
 * Screens NEVER import the overlay tree. They call `openTicket()` and the
 * provider decides what to render, which is what lets 6a land as a swap of
 * this one file.
 *
 * What the stub deliberately does NOT do: fetch the ticket, render the 7/3
 * overlay body, or own any of the ticket's mutations. It renders a minimal
 * labelled panel over a scrim so the wiring is visible and testable.
 */

import * as React from "react";

import { cn } from "@/lib/utils";
import { Mono, PillButton } from "@/components/piscine";
import { X } from "lucide-react";

export interface OpenTicketOptions {
  /** Which project the ticket belongs to. Required by the real overlay's fetch. */
  projectId?: string | null;
}

export interface TicketOverlayContextValue {
  /** The open ticket's epic id, or `null` when the overlay is closed. */
  ticketId: string | null;
  /** The open ticket's project, when the caller knew it. */
  projectId: string | null;
  open: boolean;
  openTicket: (epicId: string, options?: OpenTicketOptions) => void;
  closeTicket: () => void;
}

const TicketOverlayContext = React.createContext<TicketOverlayContextValue | null>(
  null,
);

/**
 * Read the overlay controls.
 *
 * Returns a no-op implementation outside a provider rather than throwing: a
 * desk band rendered in isolation (a unit test, the primitive preview) must not
 * need the whole app shell to mount.
 */
export function useTicketOverlay(): TicketOverlayContextValue {
  const value = React.useContext(TicketOverlayContext);
  return value ?? NOOP_OVERLAY;
}

const NOOP_OVERLAY: TicketOverlayContextValue = {
  ticketId: null,
  projectId: null,
  open: false,
  openTicket: () => {},
  closeTicket: () => {},
};

export interface TicketOverlayProviderProps {
  children: React.ReactNode;
  /**
   * Render prop for the panel body. Frame 6a's packet replaces the default
   * placeholder through this seam without changing the context contract.
   */
  renderPanel?: (state: {
    ticketId: string;
    projectId: string | null;
    close: () => void;
  }) => React.ReactNode;
}

export function TicketOverlayProvider({
  children,
  renderPanel,
}: TicketOverlayProviderProps) {
  const [ticketId, setTicketId] = React.useState<string | null>(null);
  const [projectId, setProjectId] = React.useState<string | null>(null);

  const openTicket = React.useCallback(
    (epicId: string, options?: OpenTicketOptions) => {
      setTicketId(epicId);
      setProjectId(options?.projectId ?? null);
    },
    [],
  );

  const closeTicket = React.useCallback(() => {
    setTicketId(null);
    setProjectId(null);
  }, []);

  // Escape closes — the same rule frame 6a specifies, kept here so it does not
  // have to be rediscovered when the panel is replaced.
  React.useEffect(() => {
    if (!ticketId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTicket();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ticketId, closeTicket]);

  const value = React.useMemo<TicketOverlayContextValue>(
    () => ({
      ticketId,
      projectId,
      open: ticketId !== null,
      openTicket,
      closeTicket,
    }),
    [ticketId, projectId, openTicket, closeTicket],
  );

  return (
    <TicketOverlayContext.Provider value={value}>
      {children}
      {ticketId ? (
        <div
          data-testid="ticket-overlay"
          className={cn(
            "fixed inset-0 z-50 flex items-center justify-center",
            "bg-scrim backdrop-blur-[3px]",
          )}
          onClick={closeTicket}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Ticket"
            onClick={(event) => event.stopPropagation()}
            className={cn(
              "w-[min(1200px,92vw)] rounded-[20px] bg-background p-6",
              // The ONLY shadow in the system lives on this overlay.
              "shadow-[var(--shadow-overlay)]",
            )}
          >
            {renderPanel ? (
              renderPanel({ ticketId, projectId, close: closeTicket })
            ) : (
              <div className="flex items-center gap-3">
                <Mono size={11} tone="muted">
                  {ticketId}
                </Mono>
                <span className="font-display text-[19px] font-bold text-foreground">
                  Ticket
                </span>
                <PillButton
                  className="ml-auto"
                  variant="outline"
                  outlineTone="neutral"
                  iconOnly
                  icon={X}
                  onClick={closeTicket}
                >
                  Close
                </PillButton>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </TicketOverlayContext.Provider>
  );
}
