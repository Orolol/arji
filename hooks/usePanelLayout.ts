"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_PANEL_RATIO = 0.4;
const MIN_PANEL_WIDTH = 300;
const MIN_BOARD_WIDTH = 400;
/**
 * The shared ticket panel and the chat panel are the *same* container: they
 * share one width (the persisted ratio) so switching between them never
 * changes the layout. See MIN_BOARD_WIDTH / MIN_PANEL_WIDTH for the clamps
 * that keep both the board and the panel usable on narrow windows.
 */
export const DIVIDER_WIDTH = 6;
const MOBILE_BREAKPOINT = 768;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Panel width for a given container width and ratio. Pure, so the render pass
 * can call it with the *measured* container width (state) while the drag
 * handler calls it with the live one it reads off the DOM.
 */
function panelWidthFor(totalWidth: number, ratio: number) {
  const minRatio = MIN_PANEL_WIDTH / totalWidth;
  const maxRatio = (totalWidth - MIN_BOARD_WIDTH - DIVIDER_WIDTH) / totalWidth;
  const safeRatio = clamp(ratio, minRatio, maxRatio);
  const width = Math.round(totalWidth * safeRatio);
  // Below ~706px the two minima collide (minRatio > maxRatio) and the
  // clamp degenerates into a sub-usable — even negative — width. The
  // desktop split never renders below MOBILE_BREAKPOINT (the mobile
  // Sheet takes over), but floor the result anyway so a degenerate
  // container can never emit an invalid `width` style.
  return Math.max(MIN_PANEL_WIDTH, width);
}

/** Width used until the container has been measured. */
function fallbackContainerWidth() {
  if (typeof window === "undefined") {
    return 1200;
  }
  return window.innerWidth || 1200;
}

export type UnifiedPanelState = "collapsed" | "expanded" | "hidden";

interface UsePanelLayoutOptions {
  projectId: string;
  /** Conversations used to validate the persisted active conversation id. */
  conversations: ReadonlyArray<{ id: string }>;
  activeId: string | null;
  setActiveId: (id: string) => void;
}

/**
 * Layout state machine for the unified chat panel: expanded/collapsed/hidden
 * panel state, divider drag + ratio, mobile detection, and localStorage
 * persistence of the three per-project keys
 * (`arij.unified-chat-panel.{ratio,state,active}.<projectId>`).
 *
 * The panel width applies to BOTH the chat view and the shared ticket view —
 * they are the same container, so resizing (or switching between them) never
 * changes the width.
 */
export function usePanelLayout({
  projectId,
  conversations,
  activeId,
  setActiveId,
}: UsePanelLayoutOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [panelState, setPanelState] = useState<UnifiedPanelState>("collapsed");
  const [panelRatio, setPanelRatio] = useState(DEFAULT_PANEL_RATIO);
  const [isDragging, setIsDragging] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  // The container's own width, measured after layout. Reading
  // `containerRef.current` during render returned `null` on the first pass and
  // never re-ran, so the panel stayed sized against the *window* — too wide
  // whenever the container is inset (sidebar, rail). A ResizeObserver reports
  // asynchronously, so this never re-renders synchronously from an effect.
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  const storageKey = useMemo(
    () => `arij.unified-chat-panel.ratio.${projectId}`,
    [projectId],
  );

  const stateStorageKey = useMemo(
    () => `arij.unified-chat-panel.state.${projectId}`,
    [projectId],
  );

  const activeStorageKey = useMemo(
    () => `arij.unified-chat-panel.active.${projectId}`,
    [projectId],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    function updateIsMobile() {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    }

    updateIsMobile();
    window.addEventListener("resize", updateIsMobile);
    return () => window.removeEventListener("resize", updateIsMobile);
  }, []);

  // Reads the DOM, so it belongs to event handlers only — never to render.
  const getContainerWidth = useCallback(() => {
    if (typeof window === "undefined") {
      return 1200;
    }
    return containerRef.current?.clientWidth || fallbackContainerWidth();
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) {
        setContainerWidth(width);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const panelWidthPx = panelWidthFor(
    containerWidth ?? fallbackContainerWidth(),
    panelRatio,
  );

  // Persist panelRatio — read on mount
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return;
    }
    setPanelRatio(parsed);
  }, [storageKey]);

  // Persist panelRatio — write on change
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(storageKey, panelRatio.toFixed(4));
  }, [panelRatio, storageKey]);

  // Persist panelState — read on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(stateStorageKey);
    if (raw === "expanded" || raw === "collapsed" || raw === "hidden") {
      setPanelState(raw);
    }
  }, [stateStorageKey]);

  // Persist panelState — write on change
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(stateStorageKey, panelState);
  }, [panelState, stateStorageKey]);

  // Persist activeId — read on mount (with guard to avoid overriding user switches)
  const activeIdRestoredRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeIdRestoredRef.current) return;
    activeIdRestoredRef.current = true;
    const saved = window.localStorage.getItem(activeStorageKey);
    if (saved && conversations.some((c) => c.id === saved)) {
      setActiveId(saved);
    }
  }, [activeStorageKey, conversations, setActiveId]);

  // Persist activeId — write on change
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeId) {
      window.localStorage.setItem(activeStorageKey, activeId);
    }
  }, [activeId, activeStorageKey]);

  useEffect(() => {
    if (!isDragging || panelState !== "expanded") {
      return;
    }

    function onMove(event: MouseEvent) {
      const totalWidth = getContainerWidth();
      const nextPanelWidth = clamp(
        totalWidth - event.clientX,
        MIN_PANEL_WIDTH,
        totalWidth - MIN_BOARD_WIDTH - DIVIDER_WIDTH,
      );
      setPanelRatio(nextPanelWidth / totalWidth);
    }

    function onUp() {
      setIsDragging(false);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging, panelState, getContainerWidth]);

  const startDrag = useCallback(() => {
    setIsDragging(true);
  }, []);

  const resetPanelRatio = useCallback(() => {
    setPanelRatio(DEFAULT_PANEL_RATIO);
  }, []);

  return {
    containerRef,
    panelState,
    setPanelState,
    isMobile,
    isDragging,
    startDrag,
    resetPanelRatio,
    panelWidthPx,
  };
}
