import { test, expect, type Page } from "@playwright/test";

/**
 * "Se connecter avec GitHub" (OAuth Device Flow), driven in a real browser.
 *
 * WHAT IS REAL HERE: the Settings → Intégrations page, its hydration, the
 * hook's poll loop on real timers, the clipboard, focus and the rendered
 * states. That is the half the component tests cannot speak for — they assert a
 * DOM, not a browser.
 *
 * WHAT IS STUBBED, AND WHY: the four endpoints the card talks to, at the
 * network layer.
 * - `/api/auth/github/device/{start,poll}` — completing a real flow needs the
 *   "Arij" OAuth App, which is not registered yet (`ARIJ_GITHUB_OAUTH_CLIENT_ID`
 *   is empty on purpose), and a live round-trip to github.com plus a human
 *   typing a code on it. The stubs replay the exact payloads the routes
 *   produce; the routes themselves are covered by
 *   `__tests__/github-device-flow-routes.test.ts` (33 cases).
 * - `GET`/`PATCH /api/settings` — so this spec writes NOTHING to the shared
 *   e2e database. It can therefore run beside every other spec, and a
 *   Déconnecter click here cannot clear a token another test is relying on.
 *
 * The consequence, stated plainly: this file is evidence about the UI and the
 * poll loop in a browser. It is no evidence at all about the device-flow
 * transport or about GitHub.
 */

const START_PAYLOAD = {
  data: {
    handle: "gh-device-e2e-handle",
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    interval: 1,
    expiresIn: 900,
  },
};

const CONNECTED_META = {
  login: "octocat",
  scopes: ["repo", "read:user"],
  obtainedAt: "2026-09-05T10:00:00.000Z",
  tokenSource: "oauth_device",
};

/** Serve `GET /api/settings` from a fixture and swallow every write. */
async function stubSettings(page: Page, data: Record<string, unknown>) {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ json: { data: { updated: true } } });
      return;
    }
    await route.fulfill({ json: { data, defaults: {} } });
  });
  await page.route("**/api/settings/webhooks", (route) =>
    route.fulfill({ json: { data: { webhooks: [] } } })
  );
}

test.describe("Settings → Intégrations — connexion GitHub", () => {
  test("shows the code, polls, and lands on the connected state", async ({
    page,
  }) => {
    await stubSettings(page, {});
    await page.route("**/api/auth/github/device/start", (route) =>
      route.fulfill({ json: START_PAYLOAD })
    );

    // Two `authorization_pending` ticks before the grant, so the panel is
    // observed WHILE the loop is running rather than only at its edges.
    let polls = 0;
    await page.route("**/api/auth/github/device/poll", async (route) => {
      polls += 1;
      // The browser's only reference to the flow is the opaque handle. The
      // device code is not in this request because it never left the server.
      expect(route.request().postDataJSON()).toEqual({
        handle: "gh-device-e2e-handle",
      });
      await route.fulfill({
        json:
          polls < 3
            ? { data: { state: "pending", interval: 1 } }
            : { data: { state: "success", ...CONNECTED_META } },
      });
    });

    await page.goto("/settings/integrations");

    const connect = page.getByTestId("github-connect");
    await expect(connect).toBeVisible();
    await connect.click();

    await expect(page.getByTestId("github-device-code")).toHaveText("WDJB-MJHT");
    await expect(page.getByTestId("github-device-link")).toHaveAttribute(
      "href",
      "https://github.com/login/device"
    );
    // Scoped: the tab mounts several live regions (the card's own message
    // slot, OpenAI's, Webhooks'), and only this one belongs to the flow.
    await expect(
      page.getByTestId("github-device-flow").getByRole("status")
    ).toContainText("En attente de votre autorisation");
    await page.screenshot({
      path: "e2e/test-results/github-device-flow-awaiting.png",
    });

    await expect(page.getByTestId("github-connected")).toContainText(
      "Connecté en tant que octocat",
      { timeout: 15_000 }
    );
    await expect(page.getByTestId("github-connected")).toContainText(
      "repo, read:user"
    );
    // No token was ever typed — the criterion this whole epic exists for.
    await expect(page.getByLabel("GitHub PAT")).toHaveValue("");
    await page.screenshot({
      path: "e2e/test-results/github-device-flow-connected.png",
    });
  });

  test("copies the user code to the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await stubSettings(page, {});
    await page.route("**/api/auth/github/device/start", (route) =>
      route.fulfill({ json: START_PAYLOAD })
    );
    await page.route("**/api/auth/github/device/poll", (route) =>
      route.fulfill({ json: { data: { state: "pending", interval: 5 } } })
    );

    await page.goto("/settings/integrations");
    await page.getByTestId("github-connect").click();
    await expect(page.getByTestId("github-device-code")).toBeVisible();

    await page.getByTestId("github-device-copy").click();
    await expect(page.getByTestId("github-device-copy")).toHaveText("Copié");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "WDJB-MJHT"
    );
  });

  test("surfaces an expired code and offers a way back", async ({ page }) => {
    await stubSettings(page, {});
    await page.route("**/api/auth/github/device/start", (route) =>
      route.fulfill({ json: START_PAYLOAD })
    );
    await page.route("**/api/auth/github/device/poll", (route) =>
      route.fulfill({
        status: 410,
        json: {
          error: "This GitHub sign-in expired. Start it again.",
          code: "DEVICE_FLOW_EXPIRED",
        },
      })
    );

    await page.goto("/settings/integrations");
    await page.getByTestId("github-connect").click();

    await expect(page.getByTestId("github-flow-error")).toContainText(
      "This GitHub sign-in expired. Start it again.",
      { timeout: 15_000 }
    );
    await expect(page.getByTestId("github-flow-retry")).toBeVisible();
    await expect(page.getByTestId("github-device-code")).toHaveCount(0);
    await page.screenshot({
      path: "e2e/test-results/github-device-flow-expired.png",
    });

    // The fallback the user can always reach for.
    await expect(page.getByLabel("GitHub PAT")).toBeVisible();
  });

  test("refuses gracefully when the OAuth App is not registered", async ({
    page,
  }) => {
    await stubSettings(page, {});
    await page.route("**/api/auth/github/device/start", (route) =>
      route.fulfill({
        status: 400,
        json: {
          error:
            "The Arij GitHub OAuth App is not configured yet. Paste a personal access token instead.",
          code: "CLIENT_ID_NOT_CONFIGURED",
        },
      })
    );

    await page.goto("/settings/integrations");
    await page.getByTestId("github-connect").click();

    await expect(page.getByTestId("github-flow-error")).toContainText(
      "not configured yet"
    );
    await expect(page.getByRole("button", { name: "Save Token" })).toBeVisible();
  });

  test("disconnecting returns the section to its unconfigured state", async ({
    page,
  }) => {
    await stubSettings(page, {
      github_pat: { hasToken: true },
      github_oauth_meta: CONNECTED_META,
    });

    const patches: unknown[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/settings") && request.method() === "PATCH") {
        patches.push(request.postDataJSON());
      }
    });

    await page.goto("/settings/integrations");
    await expect(page.getByTestId("github-connected")).toContainText(
      "Connecté en tant que octocat"
    );

    await page.getByRole("button", { name: "Déconnecter" }).click();

    await expect(page.getByTestId("github-connect")).toBeVisible();
    await expect(page.getByTestId("github-connected")).toHaveCount(0);
    expect(patches).toEqual([{ github_pat: "", github_oauth_meta: null }]);
    await page.screenshot({
      path: "e2e/test-results/github-device-flow-disconnected.png",
    });
  });
});
