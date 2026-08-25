import { expect, test } from "./fixtures/arij-project";
import { openTicketDetail } from "./fixtures/board";

/**
 * The activity feed of a ticket has to scroll.
 *
 * Reported as "impossible de scroll dans la partie activité d'un ticket": the
 * feed's `<ScrollArea>` is a flex item, and a flex item defaults to
 * `min-height: auto` — so without `min-h-0` its root was floored at its
 * content height. It grew past the panel instead of scrolling, and the panel's
 * `overflow-hidden` simply cut the overflow off: no scrollbar, no wheel, and
 * the comment composer parked below the visible area for good.
 *
 * Only a real browser can catch that (jsdom does no layout), and only with
 * enough entries to overflow — hence the API-seeded thread. The assertions are
 * the three symptoms, not the CSS: nothing clipped, a viewport that scrolls,
 * and a composer that stays reachable.
 */
const COMMENT_COUNT = 30;

test.describe("Ticket activity feed", () => {
  test("scrolls its feed and keeps the composer reachable", async ({
    page,
    project,
    request,
  }) => {
    const title = `Busy ticket ${project.id}`;
    const created = await request.post(`/api/projects/${project.id}/epics`, {
      data: { title, description: "A ticket with a long activity feed." },
    });
    expect(
      created.ok(),
      `epic creation failed: ${created.status()} ${await created.text()}`
    ).toBeTruthy();
    const { data: epic } = (await created.json()) as { data: { id: string } };

    // Serially: the feed is ordered by createdAt, and the route stamps it.
    for (let i = 0; i < COMMENT_COUNT; i++) {
      const comment = await request.post(
        `/api/projects/${project.id}/epics/${epic.id}/comments`,
        {
          data: {
            author: "user",
            content: `Comment ${i} — lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
          },
        }
      );
      expect(comment.ok(), `comment ${i} failed: ${comment.status()}`).toBeTruthy();
    }

    await page.goto(project.boardUrl);
    const panel = await openTicketDetail(page, title);

    await panel.getByRole("tab", { name: /Activity/ }).click();

    const feed = panel.getByTestId("activity-scroll-area");
    await expect(feed).toBeVisible();
    const viewport = feed.locator("[data-radix-scroll-area-viewport]");

    // 1. The panel contains its content — nothing is cut off by overflow-hidden.
    const panelOverflow = await panel.evaluate(
      (element) => element.scrollHeight - element.clientHeight
    );
    expect(
      panelOverflow,
      "the ticket panel overflows its own box, so part of the feed is clipped away"
    ).toBeLessThanOrEqual(1);

    // 2. The feed viewport is the box that scrolls, and it has somewhere to go.
    const geometry = await viewport.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(
      geometry.scrollHeight,
      "the feed did not overflow its viewport, so this run proves nothing about scrolling"
    ).toBeGreaterThan(geometry.clientHeight);

    // 3. The wheel actually moves it — in both directions. Distance from the
    //    bottom rather than a scrollTop target: the feed keeps settling while
    //    late content (markdown, relative timestamps) lands, so the bottom is
    //    only meaningful read together with the offset.
    const distanceFromBottom = () =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      );

    // The newest entry is what the feed opens on.
    await expect
      .poll(distanceFromBottom, {
        message: "the feed did not open on its newest entry",
      })
      .toBeLessThanOrEqual(1);

    await viewport.hover();
    await page.mouse.wheel(0, -400);
    await expect
      .poll(distanceFromBottom, { message: "scrolling up did not move the feed" })
      .toBeGreaterThan(100);

    // Generously past the bottom: the browser clamps, and the assertion stays
    // about "the wheel scrolls down" rather than about pixel arithmetic.
    await page.mouse.wheel(0, 4000);
    await expect
      .poll(distanceFromBottom, {
        message: "scrolling back down did not move the feed",
      })
      .toBeLessThanOrEqual(1);

    // 4. The composer stays inside the panel: a user who read the feed can
    //    still answer it.
    const composer = panel.getByTestId("activity-composer");
    const composerBox = await composer.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(composerBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect(
      composerBox!.y + composerBox!.height,
      "the comment composer sits below the panel, where nothing can scroll to it"
    ).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 1);
    await expect(composer.getByPlaceholder("Add a comment...")).toBeVisible();
  });

  /**
   * The user-story page carries the same thread under the same
   * `overflow-hidden` column, so it had the same defect — and it is reached by
   * its own route, which the epic panel test never loads.
   */
  test("scrolls the user story comment thread", async ({
    page,
    project,
    request,
  }) => {
    const created = await request.post(`/api/projects/${project.id}/epics`, {
      data: { title: `Story parent ${project.id}` },
    });
    expect(
      created.ok(),
      `epic creation failed: ${created.status()} ${await created.text()}`
    ).toBeTruthy();
    const { data: epic } = (await created.json()) as { data: { id: string } };

    const storyResponse = await request.post(
      `/api/projects/${project.id}/user-stories`,
      { data: { epicId: epic.id, title: "A story with a long thread" } }
    );
    expect(
      storyResponse.ok(),
      `story creation failed: ${storyResponse.status()} ${await storyResponse.text()}`
    ).toBeTruthy();
    const { data: story } = (await storyResponse.json()) as {
      data: { id: string };
    };

    for (let i = 0; i < COMMENT_COUNT; i++) {
      const comment = await request.post(
        `/api/projects/${project.id}/stories/${story.id}/comments`,
        {
          data: {
            author: "user",
            content: `Story comment ${i} — lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.`,
          },
        }
      );
      expect(comment.ok(), `comment ${i} failed: ${comment.status()}`).toBeTruthy();
    }

    await page.goto(`/projects/${project.id}/stories/${story.id}`);

    const thread = page.getByTestId("comment-scroll-area");
    await expect(thread).toBeVisible();
    const viewport = thread.locator("[data-radix-scroll-area-viewport]");

    const column = page.getByTestId("comment-composer").locator("..");
    expect(
      await column.evaluate((element) => element.scrollHeight - element.clientHeight),
      "the thread column overflows its own box, so part of it is clipped away"
    ).toBeLessThanOrEqual(1);

    const geometry = await viewport.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(
      geometry.scrollHeight,
      "the thread did not overflow its viewport, so this run proves nothing about scrolling"
    ).toBeGreaterThan(geometry.clientHeight);

    const distanceFromBottom = () =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      );

    await expect
      .poll(distanceFromBottom, {
        message: "the thread did not open on its newest comment",
      })
      .toBeLessThanOrEqual(1);

    await viewport.hover();
    await page.mouse.wheel(0, -400);
    await expect
      .poll(distanceFromBottom, { message: "scrolling up did not move the thread" })
      .toBeGreaterThan(100);

    await expect(
      page.getByTestId("comment-composer").getByPlaceholder("Add a comment...")
    ).toBeVisible();
  });
});
