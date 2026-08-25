/**
 * Tests for useFeedAutoScroll — the hook that keeps a ticket feed on its
 * newest entry.
 *
 * The regression it exists for: the ref sits on the content div inside a
 * `<ScrollArea>`, but the box that scrolls is the Radix viewport above it.
 * Writing `scrollTop` on the content div is a silent no-op, so a feed that
 * looked like it auto-scrolled never moved at all.
 *
 * jsdom does no layout, so the scroll geometry is stubbed per element — what
 * is under test is which element gets written to and when, not pixel values.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { act } from "react";
import {
  useFeedAutoScroll,
  FOLLOW_FEED_THRESHOLD_PX,
} from "@/hooks/useFeedAutoScroll";

const VIEWPORT_HEIGHT = 300;
const CONTENT_HEIGHT = 3000;

/** A `<ScrollArea>` in miniature: the Radix viewport plus the content div. */
function Feed({ itemCount }: { itemCount: number }) {
  const scrollRef = useFeedAutoScroll(itemCount);
  return (
    <div data-radix-scroll-area-viewport="" data-testid="viewport">
      <div ref={scrollRef} data-testid="content">
        {Array.from({ length: itemCount }, (_, i) => (
          <p key={i}>entry {i}</p>
        ))}
      </div>
    </div>
  );
}

/**
 * Gives an element a fixed scroll geometry. `scrollTop` stays a real
 * read/write property so the assertions read back what the hook wrote.
 */
function stubGeometry(
  element: HTMLElement,
  { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }
): void {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
}

function renderFeed(itemCount: number) {
  const view = render(<Feed itemCount={itemCount} />);
  const viewport = view.getByTestId("viewport");
  const content = view.getByTestId("content");
  stubGeometry(viewport, {
    scrollHeight: CONTENT_HEIGHT,
    clientHeight: VIEWPORT_HEIGHT,
  });
  stubGeometry(content, { scrollHeight: CONTENT_HEIGHT, clientHeight: CONTENT_HEIGHT });
  return { ...view, viewport, content };
}

/** Moves the viewport the way a reader's wheel would, event included. */
function scrollTo(viewport: HTMLElement, top: number): void {
  viewport.scrollTop = top;
  act(() => {
    viewport.dispatchEvent(new Event("scroll"));
  });
}

const BOTTOM = CONTENT_HEIGHT - VIEWPORT_HEIGHT;

describe("useFeedAutoScroll", () => {
  it("pins the viewport — not the content div — to the newest entry", () => {
    const { viewport, content, rerender } = renderFeed(0);

    rerender(<Feed itemCount={12} />);

    expect(viewport.scrollTop).toBe(CONTENT_HEIGHT);
    // The old bug wrote here, where scrolling does nothing.
    expect(content.scrollTop).toBe(0);
  });

  it("leaves an empty feed alone", () => {
    const { viewport } = renderFeed(0);

    expect(viewport.scrollTop).toBe(0);
  });

  it("does not yank a reader who scrolled up into the history", () => {
    const { viewport, rerender } = renderFeed(0);
    rerender(<Feed itemCount={12} />);

    const parked = BOTTOM - FOLLOW_FEED_THRESHOLD_PX - 1;
    scrollTo(viewport, parked);
    rerender(<Feed itemCount={13} />);

    expect(viewport.scrollTop).toBe(parked);
  });

  it("keeps following inside the bottom band", () => {
    const { viewport, rerender } = renderFeed(0);
    rerender(<Feed itemCount={12} />);

    scrollTo(viewport, BOTTOM - FOLLOW_FEED_THRESHOLD_PX);
    rerender(<Feed itemCount={13} />);

    expect(viewport.scrollTop).toBe(CONTENT_HEIGHT);
  });

  it("resumes following once the reader comes back down", () => {
    const { viewport, rerender } = renderFeed(0);
    rerender(<Feed itemCount={12} />);

    scrollTo(viewport, 0);
    rerender(<Feed itemCount={13} />);
    expect(viewport.scrollTop).toBe(0);

    scrollTo(viewport, BOTTOM);
    rerender(<Feed itemCount={14} />);
    expect(viewport.scrollTop).toBe(CONTENT_HEIGHT);
  });
});
