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

    const viewport = panel.getByTestId("ticket-reply-input").locator("..").locator("..").locator("div.overflow-y-auto");
    await expect(viewport).toBeVisible();
    await viewport.scrollIntoViewIfNeeded();
    const geometry = await viewport.evaluate(element => ({
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
    }));
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    await viewport.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
    await page.mouse.wheel(0, -4000);
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
    const composer = panel.getByTestId("ticket-reply-input");
    await composer.scrollIntoViewIfNeeded();
    await expect(composer).toBeVisible();
    await composer.fill("The conversation still accepts replies after scrolling.");
    await panel.getByTestId("ticket-reply-send").click();
    await expect(composer).toHaveValue("");
    await expect(viewport.getByText("The conversation still accepts replies after scrolling.")).toBeAttached();
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
