import {
  commitSubjects, createEpic, epicFindings, epicSessions, expect, localBranches,
  pinProjectAgents, storedEpicBranch, storedEpicStatus, test, unpinProjectAgents,
} from "./fixtures/arij-project";
import { changeTicketStatus, openRegistry, openTicketDetail, ticketCard } from "./fixtures/board";
import { assertCliStubInstalled, cleanupScenarios, readInvocations, writeScenario } from "./fixtures/cli-stub";

// Only the external CLI is scripted. Dispatch, worktrees, sessions, MCP
// findings, workflow promotions and the final git merge all run in Arij.
test.describe("Build to review to merge", () => {
  test.afterEach(async ({ request, project }) => {
    cleanupScenarios();
    await unpinProjectAgents(request, project.id);
  });

  test("builds and reviews a registry ticket, then lands its commit from the overlay", async ({
    page, project, request, baseURL,
  }) => {
    test.setTimeout(300_000);
    await assertCliStubInstalled(request, baseURL!);
    await pinProjectAgents(request, project.id);
    const title = `Shipping epic ${project.id}`;
    const epic = await createEpic(request, project.id, title, "Delivered through real dispatch.");
    const commitMessage = `Implement ${title}`;
    writeScenario(epic.id, [
      { kind: "build", file: "FEATURE.md", content: `# ${title}\n`, message: commitMessage,
        say: "Implemented the feature and committed it on the epic branch." },
      { kind: "review", verdict: "approved", summary: "The change implements the ticket.",
        findings: [{ file_path: "FEATURE.md", line: 1, body: "The heading could name the ticket id.", severity: "minor" }],
        say: "Reviewed the diff. One small remark, nothing that holds the merge." },
    ]);

    await openRegistry(page, project.id);
    const panel = await openTicketDetail(page, title);
    await panel.getByTestId("ticket-rebuild").click();
    const dialog = page.getByRole("dialog").filter({ has: page.getByTestId("pipeline-checkbox") });
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("pipeline-checkbox").uncheck();
    const dispatched = page.waitForResponse(r => r.url().includes(`/epics/${epic.id}/build`) && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Dispatch Agent" }).click();
    const buildResponse = await dispatched;
    expect(buildResponse.ok(), await buildResponse.text()).toBeTruthy();
    await expect(dialog).toBeHidden({ timeout: 45_000 });
    await expect.poll(() => storedEpicStatus(request, project.id, epic.id), { timeout: 60_000 }).toBe("review");

    const afterBuild = await epicSessions(request, project.id, epic.id);
    expect(afterBuild.map(s => s.agentType)).toEqual(["build"]);
    expect(afterBuild[0]).toMatchObject({ status: "completed", provider: "claude-code", outcome: "answered" });
    const branch = afterBuild[0].branchName!;
    expect(branch).toBeTruthy();
    expect(await storedEpicBranch(request, project.id, epic.id)).toBe(branch);
    expect(commitSubjects(project.repoPath, branch)).toContain(commitMessage);

    // Exercise the refusing side of the review gate through the status menu.
    await expect(panel.getByTestId("ticket-status-control")).toContainText("Review");
    expect(await changeTicketStatus(page, "To Merge")).toBe(400);
    await expect(panel.getByTestId("ticket-status-error")).toContainText(/no completed review/i);
    expect(await storedEpicStatus(request, project.id, epic.id)).toBe("review");

    const reviewed = page.waitForResponse(r => r.url().includes(`/epics/${epic.id}/review`) && r.request().method() === "POST");
    await panel.getByTestId("ticket-review-now").click();
    const reviewResponse = await reviewed;
    expect(reviewResponse.ok(), await reviewResponse.text()).toBeTruthy();
    await expect.poll(() => storedEpicStatus(request, project.id, epic.id), { timeout: 60_000 }).toBe("to_merge");
    const afterReview = await epicSessions(request, project.id, epic.id);
    expect(afterReview.map(s => s.agentType)).toEqual(["build", "review_feature"]);
    expect(afterReview[1]).toMatchObject({ status: "completed", provider: "claude-code", reviewVerdict: "approved" });
    const findings = await epicFindings(request, project.id, epic.id);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ status: "open", filePath: "FEATURE.md", agentSessionId: afterReview[1].id });
    expect(findings[0].body).toContain("[minor]");

    await expect(panel.getByTestId("ticket-merge")).toBeVisible();
    const merged = page.waitForResponse(r => r.url().includes(`/epics/${epic.id}/merge`) && r.request().method() === "POST", { timeout: 90_000 });
    await panel.getByTestId("ticket-merge").click();
    const mergeResponse = await merged;
    expect(mergeResponse.ok(), await mergeResponse.text()).toBeTruthy();
    await expect.poll(() => storedEpicStatus(request, project.id, epic.id)).toBe("done");
    await expect(panel).toBeHidden();
    await expect(ticketCard(page, title)).toBeVisible();

    const subjects = commitSubjects(project.repoPath);
    expect(subjects).toContain(commitMessage);
    expect(subjects).toContain(`Merge ${branch}`);
    expect(localBranches(project.repoPath)).not.toContain(branch);
    expect(await storedEpicBranch(request, project.id, epic.id)).toBeNull();
    const invocations = readInvocations(epic.id);
    expect(invocations.map(i => i.kind)).toEqual(["build", "review"]);
    expect(invocations.every(i => i.ok)).toBe(true);
    expect(invocations.map(i => i.hasMcpChannel)).toEqual([true, true]);
    expect(invocations[1].submitFindings).toMatchObject({ status: 200, verdict: "approved" });
    for (const invocation of invocations) {
      expect(invocation.cwd).toContain(".arij-worktrees");
      expect(invocation.prompt).toContain(title);
    }
  });
});
