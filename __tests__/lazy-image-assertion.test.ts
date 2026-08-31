import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { naturalWidthOfLazyImage, type LazyImage } from "@/e2e/fixtures/board";

/**
 * `e2e/bug-image-paste.spec.ts` proves the pasted bytes survive the round trip
 * by decoding them: `naturalWidth > 0` on the thumbnail the ticket detail
 * renders. That assertion used to poll `Locator.evaluate()` directly, and it
 * was flaky on a cold server.
 *
 * The reason is not latency. The thumbnail carries `loading="lazy"`, so Chrome
 * issues the request only once the element approaches the viewport, and
 * `Locator.evaluate()` runs no actionability checks — unlike `click()` or
 * `scrollIntoViewIfNeeded()`, it never scrolls. Measured in a browser against
 * a lazy image 3000px down a scroll container: fifteen `evaluate` ticks over
 * three seconds returned `naturalWidth === 0` with zero network requests
 * issued, and the first `scrollIntoViewIfNeeded()` fetched it. Whether the old
 * assertion passed came down to where the panel's layout happened to drop the
 * thumbnail relative to Chrome's lazy threshold — and when it lands outside,
 * no poll timeout is long enough, because nothing is in flight.
 *
 * `naturalWidthOfLazyImage` is the fix: scroll, then read. Pinned here rather
 * than in the Playwright suite because the interesting cases — an image the
 * browser was never asked to fetch, and bytes that come back broken — are
 * exactly the ones a working app cannot produce on demand. The stub below
 * models the browser rule the helper exists to satisfy.
 */

interface StubImage extends LazyImage {
  /** How many times the helper asked for the element to be scrolled to. */
  scrolls: number;
  /** How many times it read a property off the element. */
  reads: number;
}

/**
 * An image that behaves the way Chrome does with `loading="lazy"`: it has no
 * decoded bytes until something scrolls it into view.
 *
 * `widthOnceFetched` is the width the served bytes decode to — 0 models a
 * broken or truncated response, which must stay 0 however much it is scrolled
 * to and polled.
 */
function lazyImageStub(widthOnceFetched = 16): StubImage {
  let fetched = false;
  const stub: StubImage = {
    scrolls: 0,
    reads: 0,
    async scrollIntoViewIfNeeded() {
      stub.scrolls++;
      fetched = true;
    },
    async evaluate<R>(pageFunction: (element: HTMLImageElement) => R): Promise<R> {
      stub.reads++;
      return pageFunction({
        naturalWidth: fetched ? widthOnceFetched : 0,
      } as HTMLImageElement);
    },
  };
  return stub;
}

describe("naturalWidthOfLazyImage", () => {
  it("scrolls the image into view before reading it, so a lazy image is fetched at all", async () => {
    const image = lazyImageStub();

    await expect(naturalWidthOfLazyImage(image)).resolves.toBe(16);
    expect(image.scrolls).toBe(1);
    expect(image.reads).toBe(1);
  });

  it("reads 0 without the scroll, which is the flake the helper removes", async () => {
    // The pre-fix assertion, spelled out: `evaluate` alone, no actionability
    // check, no scroll. It never observes anything but 0 — polling it longer
    // changes nothing, because the browser was never asked for the bytes.
    const image = lazyImageStub();

    const width = await image.evaluate((element) => element.naturalWidth);

    expect(width).toBe(0);
    expect(image.scrolls).toBe(0);
  });

  it("still reports 0 when the served bytes do not decode", async () => {
    // Acceptance criterion: the check must not become vacuous. A broken serve
    // response still fails the spec's `toBeGreaterThan(0)`.
    const broken = lazyImageStub(0);

    await expect(naturalWidthOfLazyImage(broken)).resolves.toBe(0);
    expect(broken.scrolls).toBe(1);
  });

  it("re-establishes visibility on every call, so a poll retries the whole thing", async () => {
    // The helper is the poll body, not a one-off preamble: the detail panel can
    // still be settling when the first tick runs, so each tick has to scroll
    // again rather than trust the previous one.
    const image = lazyImageStub();

    await naturalWidthOfLazyImage(image);
    await naturalWidthOfLazyImage(image);
    await naturalWidthOfLazyImage(image);

    expect(image.scrolls).toBe(3);
    expect(image.reads).toBe(3);
  });
});

describe("e2e/bug-image-paste.spec.ts", () => {
  const source = readFileSync(
    path.resolve(__dirname, "..", "e2e", "bug-image-paste.spec.ts"),
    "utf8"
  );

  it("polls the helper rather than a bare evaluate", () => {
    expect(source).toContain("naturalWidthOfLazyImage(thumbnails.first())");
    expect(source).not.toMatch(/\.evaluate\(\s*\(img: HTMLImageElement\)/);
  });

  it("still asserts the thumbnail decoded", () => {
    // Deleting the naturalWidth check would "de-flake" the spec by making it
    // prove nothing about the served bytes. That is not the fix.
    expect(source).toContain("toBeGreaterThan(0)");
  });
});
