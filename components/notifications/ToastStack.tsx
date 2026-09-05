"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, TriangleAlert, X } from "lucide-react";
import { SurfaceCard } from "@/components/piscine/SurfaceCard";

export interface ToastItem {
  id: string;
  type: ToastTone;
  message: string;
  href?: string;
  actionLabel?: string;
}

/**
 * The ONE tone vocabulary. Every surface aliases this rather than re-declaring
 * the union — three copies of it had already drifted out of one file each.
 */
export type ToastTone = "success" | "error" | "warning";

/** The optional deep link a toast can carry, e.g. to the session in the way. */
export interface ToastAction {
  href: string;
  label?: string;
}

/** What a surface calls to raise one. See `useToastStack`. */
export type RaiseToast = (
  tone: ToastTone,
  message: string,
  action?: ToastAction,
) => void;

export const TOAST_DURATION_MS = 8000;
export const MAX_TOASTS = 4;
/** Where an action-less link lands, when the caller names nothing better. */
export const TOAST_DEFAULT_ACTION_LABEL = "Open session";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** The app's ONE toast stack; the portal is what escapes a page's scroll containers. */
export function ToastStack({ items, onDismiss, testId }: {
  items: readonly ToastItem[];
  onDismiss: (id: string) => void;
  testId?: string;
}) {
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  if (!mounted) return null;
  return createPortal(
    <section aria-label="Notifications" className="pointer-events-none fixed right-4 top-[76px] z-[100] flex max-h-[calc(100dvh-92px)] w-[380px] max-w-[calc(100vw-32px)] flex-col gap-3 overflow-y-auto">
      {items.slice(-MAX_TOASTS).map((item) => (
        <Toast key={item.id} item={item} onDismiss={onDismiss} testId={testId} />
      ))}
    </section>,
    document.body,
  );
}

function Toast({ item, onDismiss, testId }: {
  item: ToastItem;
  onDismiss: (id: string) => void;
  testId?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Errors remain until dismissed. Reading or following a link pauses expiry.
  useEffect(() => {
    if (hovered || focused || item.type !== "success") return;
    const timer = setTimeout(() => onDismiss(item.id), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [hovered, focused, item.id, item.type, onDismiss]);
  const Icon = item.type === "success" ? CheckCircle2 : TriangleAlert;
  return (
    <SurfaceCard
      role={item.type === "success" ? "status" : "alert"}
      aria-atomic="true"
      data-testid={testId}
      data-toast-type={item.type}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      className="pointer-events-auto flex items-start gap-3 border-border-strong p-4 font-sans text-[13px] text-foreground shadow-lg"
    >
      <Icon size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <p>{item.message}</p>
        {item.href ? (
          <a href={item.href} className="mt-2 inline-block font-semibold underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">
            {item.actionLabel || TOAST_DEFAULT_ACTION_LABEL}
          </a>
        ) : null}
      </div>
      <button type="button" aria-label="Fermer la notification" onClick={() => onDismiss(item.id)} className="flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
        <X size={15} aria-hidden="true" />
      </button>
    </SurfaceCard>
  );
}
