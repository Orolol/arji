import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import nextConfig from "@/next.config";

/**
 * Two layers decide whether a locally-browsed page works, and they have to
 * agree.
 *
 * `middleware.ts` decides which hosts may call `/api/*`. It accepts the three
 * loopback spellings a developer can type: `localhost`, `127.0.0.1` and
 * `[::1]`.
 *
 * `next dev` separately decides which hosts may load `/_next/*` — the chunks
 * that hydrate the page. Next 16.3 blocks that cross-site by default against
 * an allowlist of `['**.localhost', 'localhost']` plus `allowedDevOrigins`
 * plus whatever `--hostname` bound. Chrome labels the chunk `<script>` loads
 * of a page served from an IP literal `Sec-Fetch-Site: cross-site`, so without
 * `allowedDevOrigins` a developer on `http://127.0.0.1:3000` gets 403 on every
 * chunk.
 *
 * The failure is silent in the worst way: the API answers (middleware said
 * yes), the server markup renders, and hydration simply never runs. No error
 * surfaces — the board just sits there. The e2e suite hit the same wall from
 * its `127.0.0.1` base URL and failed 4/7 on a skeleton.
 *
 * So the invariant under test is parity: every host the API layer accepts must
 * also be served dev resources. A host accepted by one and refused by the
 * other is the bug.
 */

/** Loopback spellings a developer can put in the address bar. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

async function getMiddleware() {
  const mod = await import("@/middleware");
  return mod.middleware;
}

/** Does `middleware.ts` let this host reach the API? */
async function apiAccepts(host: string): Promise<boolean> {
  const middleware = await getMiddleware();
  const res = middleware(
    new NextRequest(`http://${host}:3000/api/projects`, {
      headers: { host: `${host}:3000` },
    })
  );
  return res.status !== 403;
}

/**
 * Does `next dev` serve a `/_next/*` chunk to a page on this host?
 *
 * Drives Next's own enforcement module with this repo's real
 * `allowedDevOrigins`, rather than restating what we hope the rule is. The
 * header pair is what Chrome actually sends for a `<script>` load from an IP
 * literal, and both are required — `no-cors` alone is not blocked.
 *
 * `hostname` is `undefined` because `npm run dev` and the Playwright web
 * server both start `next dev` with no `--hostname`, so nothing extra is
 * appended to the allowlist. Verified against a live server on this pin: with
 * this header pair a `127.0.0.1` referer got 403 and a `localhost` referer got
 * 200.
 */
async function devResourceServed(host: string): Promise<boolean> {
  // Deep import: this is the module whose behaviour the fix depends on, and
  // it is new in Next 16.3 (it does not exist in 16.1.6). If a Next upgrade
  // moves it, this test should fail loudly — re-verifying dev-origin
  // behaviour on a version bump is exactly the point.
  const { blockCrossSiteDEV } = await import(
    "next/dist/server/lib/router-utils/block-cross-site-dev"
  );

  const req = {
    url: "/_next/static/chunks/main-app.js",
    headers: {
      "sec-fetch-mode": "no-cors",
      "sec-fetch-site": "cross-site",
      referer: `http://${host}:3000/`,
    },
  };
  // `blockRequest` only writes a status when `statusCode` is an own property.
  const res = { statusCode: 200, end: () => {} };

  const blocked = blockCrossSiteDEV(
    req as never,
    res as never,
    nextConfig.allowedDevOrigins,
    undefined
  );
  return !blocked && res.statusCode !== 403;
}

describe("next.config allowedDevOrigins", () => {
  beforeEach(() => {
    // The enforcement module logs the block through `warnOnce`; the expected
    // blocks below would otherwise print a wall of advice.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(LOOPBACK_HOSTS)(
    "serves dev resources to %s, the same host the API middleware accepts",
    async (host) => {
      expect(await apiAccepts(host)).toBe(true);
      expect(await devResourceServed(host)).toBe(true);
    }
  );

  it("still blocks dev resources from a non-loopback host", async () => {
    // Guards the fix against being "widened" into a wildcard: the point is
    // parity with the API's loopback allowlist, not switching the protection
    // off. This host is refused by the API middleware too.
    expect(await apiAccepts("evil.example.com")).toBe(false);
    expect(await devResourceServed("evil.example.com")).toBe(false);
  });
});
