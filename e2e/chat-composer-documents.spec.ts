import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures/arij-project";

/**
 * The chat composer's documents load, watched from the network log.
 *
 * A BARE `/chat` IS THE REPRO, and `?project=` is not: `ChatPageView` seeds its
 * chosen project from the query param during render, so a deep link never
 * paints `EmptyChatWorkspace`. Without the param the desk has to answer first,
 * and until it does the page renders that empty workspace — whose composer
 * carries `projectId={null}`. The field used to receive `projectId ?? ""`, and
 * `/api/projects/${""}/documents` does not stay an empty segment: the URL
 * parser collapses it to `/api/projects/documents`, a route nothing serves. An
 * exploratory audit counted six such 404s in one session.
 *
 * Only a browser shows the first half. A component test can assert the URL the
 * component asked for, but the collapse is the URL parser's doing and the
 * empty-workspace window is the page's, so the evidence for "no 404 on load" is
 * the real request log of the real route.
 */

const MENTION_DOC = "arij-e2e-mention.md";

/** Every documents-ish path the page asks for, in order, from now on. */
function recordDocumentRequests(page: Page): string[] {
  const paths: string[] = [];
  page.on("request", (req) => {
    const { pathname } = new URL(req.url());
    if (pathname.includes("documents")) paths.push(pathname);
  });
  return paths;
}

/** The malformed shapes the audit saw, both spellings of the same mistake. */
function malformed(paths: string[]): string[] {
  return paths.filter(
    (pathname) =>
      pathname === "/api/projects/documents" || pathname.includes("//"),
  );
}

test("a bare /chat asks for no documents while the project is unresolved", async ({
  page,
  project,
}) => {
  const documentPaths = recordDocumentRequests(page);

  await page.goto("/chat");

  // The roster's GET auto-creates the default Brainstorm conversation, and the
  // composer stays disabled until one exists — so this is the marker that the
  // page got all the way through resolving a project.
  await expect(page.getByTestId("chat-composer-input")).toBeEnabled();

  // Non-vacuous: the resolved project (whichever the desk ranked first — this
  // spec does not choose one) must still have had its documents loaded.
  await expect
    .poll(() => documentPaths.some((p) => /^\/api\/projects\/[^/]+\/documents$/.test(p)))
    .toBe(true);
  expect(malformed(documentPaths)).toEqual([]);
  // The fixture's project exists, so "no project at all" is not the reason the
  // malformed request is absent.
  expect(project.id).toBeTruthy();
});

test("the resolved project's documents are citable with @", async ({
  page,
  project,
  request,
}) => {
  const upload = await request.post(`/api/projects/${project.id}/documents`, {
    multipart: {
      file: {
        name: MENTION_DOC,
        mimeType: "text/markdown",
        buffer: Buffer.from("# A document the composer can cite\n"),
      },
    },
  });
  expect(upload.status()).toBe(201);

  const documentPaths = recordDocumentRequests(page);

  await page.goto(`/chat?project=${project.id}`);

  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEnabled();

  // The guard delays the load, it does not drop it.
  await composer.click();
  await composer.pressSequentially("@");
  await expect(page.getByRole("button", { name: MENTION_DOC })).toBeVisible();

  expect(documentPaths).toContain(`/api/projects/${project.id}/documents`);
  expect(malformed(documentPaths)).toEqual([]);
});
