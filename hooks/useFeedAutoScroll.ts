"use client";

import { useEffect, useRef } from "react";

/**
 * How close to the bottom the reader has to be for a feed to keep following
 * new entries. Above it, someone is reading the history and is left alone.
 */
export const FOLLOW_FEED_THRESHOLD_PX = 80;

/** The box a `<ScrollArea>` actually scrolls, from anything rendered inside it. */
function viewportOf(content: HTMLElement | null): HTMLElement | null {
  return (
    content?.closest<HTMLElement>("[data-radix-scroll-area-viewport]") ?? null
  );
}

function isAtBottom(viewport: HTMLElement): boolean {
  return (
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
    FOLLOW_FEED_THRESHOLD_PX
  );
}

/**
 * Keeps a ticket feed (activity, comment thread) pinned to its newest entry.
 *
 * Returns a ref meant for the *content* div rendered inside `<ScrollArea>`.
 * The box that actually scrolls is the Radix viewport above it, so the hook
 * walks up to `[data-radix-scroll-area-viewport]`: writing `scrollTop` on the
 * content div is a silent no-op, which is how both feeds used to open on
 * their oldest entry.
 *
 * Following stops as soon as the reader scrolls up out of the bottom band —
 * an agent event landing must not yank someone away from the history they
 * are reading — and resumes when they come back down. Entries whose height
 * settles late (markdown, images) are caught by a resize observer, so the
 * feed does not open a few pixels short of its last item.
 */
export function useFeedAutoScroll(itemCount: number) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Whether new entries should pull the viewport down with them. */
  const followingRef = useRef(true);

  // Reading the history opts out of following; coming back down opts in.
  useEffect(() => {
    const viewport = viewportOf(scrollRef.current);
    if (!viewport) return;

    const onScroll = () => {
      followingRef.current = isAtBottom(viewport);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);

  // Both boxes settle after the first pin: entries whose height lands late
  // (markdown, images) grow the content, and panel chrome that resolves late
  // (the agent action bar) shrinks the viewport. Either one leaves the feed
  // short of its newest entry, so both are watched.
  useEffect(() => {
    const content = scrollRef.current;
    const viewport = viewportOf(content);
    if (!content || !viewport || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (!followingRef.current) return;
      viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = viewportOf(scrollRef.current);
    if (!viewport || itemCount === 0 || !followingRef.current) return;

    viewport.scrollTop = viewport.scrollHeight;
  }, [itemCount]);

  return scrollRef;
}
