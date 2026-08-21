/**
 * A screenshot attached to a bug is useless until an agent can open it.
 *
 * The reading side (`parseTicketImages`) speaks repo-relative paths because
 * that is what an `<img src>` needs; an agent is spawned inside a worktree of
 * the *user's* project, where `data/uploads/...` resolves to nothing. These
 * tests pin the two halves of the fix: the stored value becomes an absolute
 * path, and that path reaches every prompt an agent can be dispatched with.
 */
import { describe, expect, it } from "vitest";
import path from "path";
import { ticketImageAbsolutePaths } from "@/lib/uploads/ticket-image-paths";
import {
  TICKET_IMAGES_HEADING,
  ticketImagesSection,
} from "@/lib/claude/prompt-sections";
import {
  buildBuildPrompt,
  buildEpicReviewPrompt,
  buildReviewPrompt,
  buildTeamBuildPrompt,
  buildTicketBuildPrompt,
  type PromptEpic,
  type PromptProject,
  type PromptUserStory,
  type TeamEpic,
} from "@/lib/claude/prompt-builder";

const projectId = "proj-1";

/** No `id`, explicit `memory`: keeps the builders away from the database. */
const project: PromptProject = {
  name: "Arij",
  spec: "## Spec\nNext.js and SQLite",
  memory: null,
};

const story: PromptUserStory = {
  title: "As a user I can see the board",
  description: "Render the kanban columns",
  acceptanceCriteria: "- [ ] Columns render",
};

function absoluteUpload(fileName: string): string {
  return path.join(process.cwd(), "data", "uploads", projectId, fileName);
}

/** A bug as the dispatch routes load it: the whole Drizzle row. */
function bugRow(images: unknown): PromptEpic {
  return {
    title: "Board renders blank",
    description: "Opening the board shows nothing after login",
    type: "bug",
    projectId,
    images,
  };
}

describe("ticketImageAbsolutePaths()", () => {
  it("resolves a stored upload path against the Arij working directory", () => {
    const stored = JSON.stringify([`data/uploads/${projectId}/abc-shot.png`]);

    expect(ticketImageAbsolutePaths(stored, projectId)).toEqual([
      absoluteUpload("abc-shot.png"),
    ]);
  });

  it("preserves order across several screenshots", () => {
    const stored = JSON.stringify([
      `data/uploads/${projectId}/one.png`,
      `data/uploads/${projectId}/two.png`,
    ]);

    expect(ticketImageAbsolutePaths(stored, projectId)).toEqual([
      absoluteUpload("one.png"),
      absoluteUpload("two.png"),
    ]);
  });

  it("accepts an already-parsed array as well as the stored JSON text", () => {
    const paths = [`data/uploads/${projectId}/shot.png`];

    expect(ticketImageAbsolutePaths(paths, projectId)).toEqual(
      ticketImageAbsolutePaths(JSON.stringify(paths), projectId)
    );
  });

  it("strips the `./` prefix and surrounding whitespace the reader tolerates", () => {
    const stored = JSON.stringify([`  ./data/uploads/${projectId}/shot.png  `]);

    expect(ticketImageAbsolutePaths(stored, projectId)).toEqual([
      absoluteUpload("shot.png"),
    ]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty array", "[]"],
    ["malformed JSON", "{not json"],
    ["a bare JSON string", `"data/uploads/${projectId}/shot.png"`],
    ["a number", 42],
  ])("hands an agent nothing to read for %s", (_label, raw) => {
    expect(ticketImageAbsolutePaths(raw, projectId)).toEqual([]);
  });

  it.each([
    ["another project's upload", "data/uploads/proj-2/shot.png"],
    ["a traversal attempt", `data/uploads/${projectId}/../../../etc/passwd`],
    ["an absolute path outside uploads", "/etc/passwd"],
    ["a nested path", `data/uploads/${projectId}/nested/shot.png`],
  ])("refuses to put %s in a prompt", (_label, entry) => {
    expect(ticketImageAbsolutePaths(JSON.stringify([entry]), projectId)).toEqual(
      []
    );
  });

  it("keeps the usable entries when one member of the array is not", () => {
    const stored = JSON.stringify([
      "/etc/passwd",
      `data/uploads/${projectId}/shot.png`,
    ]);

    expect(ticketImageAbsolutePaths(stored, projectId)).toEqual([
      absoluteUpload("shot.png"),
    ]);
  });
});

describe("ticketImagesSection()", () => {
  it("lists the absolute paths under the attachment heading", () => {
    const section = ticketImagesSection(
      bugRow(
        JSON.stringify([
          `data/uploads/${projectId}/one.png`,
          `data/uploads/${projectId}/two.png`,
        ])
      ),
      { headingLevel: 3 }
    );

    expect(section).toContain(`### ${TICKET_IMAGES_HEADING}`);
    expect(section).toContain(`- ${absoluteUpload("one.png")}`);
    expect(section).toContain(`- ${absoluteUpload("two.png")}`);
    expect(section).toContain("2 screenshots");
  });

  it("renders the heading at exactly the level the caller asked for", () => {
    // There is no safe default: a level that closes the surrounding block
    // instead of joining it re-parents every section that follows, and nothing
    // else in the prompt says so.
    for (const headingLevel of [2, 3, 4]) {
      expect(
        ticketImagesSection(
          bugRow(JSON.stringify([`data/uploads/${projectId}/one.png`])),
          { headingLevel }
        )
      ).toMatch(
        new RegExp(`^#{${headingLevel}} ${TICKET_IMAGES_HEADING}$`, "m")
      );
    }
  });

  it("is empty for a ticket with no images", () => {
    expect(ticketImagesSection(bugRow(null), { headingLevel: 3 })).toBe("");
  });

  it("is empty for a projection that carries no project id", () => {
    // Chat/spec builders pass `{ title }` projections; they must not throw or
    // guess which project an upload path belongs to.
    expect(
      ticketImagesSection(
        {
          title: "Board renders blank",
          images: JSON.stringify([`data/uploads/${projectId}/shot.png`]),
        },
        { headingLevel: 3 }
      )
    ).toBe("");
  });
});

/**
 * The four builders behind every way a ticket reaches an agent:
 * Send-to-Dev and Create And Fix on a bug (`buildBuildPrompt`), the pipeline's
 * story build (`buildTicketBuildPrompt`), and both review scopes.
 */
const BUILDERS: Array<{ name: string; build: (epic: PromptEpic) => string }> = [
  {
    name: "buildBuildPrompt",
    build: (epic) => buildBuildPrompt(project, [], epic, [], "system"),
  },
  {
    name: "buildTicketBuildPrompt",
    build: (epic) => buildTicketBuildPrompt(project, [], epic, story, [], "system"),
  },
  {
    name: "buildReviewPrompt",
    build: (epic) =>
      buildReviewPrompt(project, [], epic, story, "feature_review", "system"),
  },
  {
    name: "buildEpicReviewPrompt",
    build: (epic) =>
      buildEpicReviewPrompt(project, [], epic, [], "feature_review", "system"),
  },
];

describe.each(BUILDERS)("$name", ({ build }) => {
  it("references the screenshots' local paths", () => {
    const prompt = build(
      bugRow(JSON.stringify([`data/uploads/${projectId}/abc-shot.png`]))
    );

    expect(prompt).toContain(absoluteUpload("abc-shot.png"));
    // Anchored: `toContain("## …")` also matches `### …`, which is how the
    // solo builders' heading level went unpinned while team mode's was not.
    expect(prompt).toMatch(new RegExp(`^### ${TICKET_IMAGES_HEADING}$`, "m"));
    // Every block around it is `###`; an `##` here would close the epic's.
    expect(prompt).not.toMatch(new RegExp(`^## ${TICKET_IMAGES_HEADING}$`, "m"));
  });

  it("leaves a ticket without images byte-identical to before the feature", () => {
    // `{ title, description, type }` is exactly what a PromptEpic was before
    // the images/projectId fields existed.
    const withoutFields = build({
      title: "Board renders blank",
      description: "Opening the board shows nothing after login",
      type: "bug",
    });

    expect(build(bugRow(null))).toBe(withoutFields);
    expect(build(bugRow("[]"))).toBe(withoutFields);
    // A path this project cannot serve is not a path an agent can read: it
    // must produce no section at all, not an empty one.
    expect(build(bugRow(JSON.stringify(["/etc/passwd"])))).toBe(withoutFields);
  });
});

/**
 * The fifth dispatch — "Build as Team" — is the odd one out: it hands the
 * builder a hand-written projection instead of the epic row, so it is the only
 * path that can drop the screenshots while every other one carries them. It
 * did exactly that until `TeamEpic` was widened.
 */
describe("buildTeamBuildPrompt", () => {
  const screenshot = JSON.stringify([`data/uploads/${projectId}/abc-shot.png`]);

  /** A batched bug as the build route assembles it from the Drizzle row. */
  function teamEpic(images: unknown, title = "Board renders blank"): TeamEpic {
    return {
      title,
      description: "Opening the board shows nothing after login",
      worktreePath: `/repos/.arij-worktrees/bug-${title.length}`,
      userStories: [story],
      projectId,
      images,
    };
  }

  it("references the screenshots of a bug batched into the build", () => {
    const prompt = buildTeamBuildPrompt(
      project,
      [],
      [teamEpic(screenshot)],
      "system"
    );

    expect(prompt).toContain(TICKET_IMAGES_HEADING);
    expect(prompt).toContain(absoluteUpload("abc-shot.png"));
  });

  it("keeps the paths inside the block of the epic they belong to", () => {
    // The team lead reads several tickets in one prompt and delegates each to
    // a different sub-agent. Screenshots that drift out of their epic are
    // worse than absent ones — they send the wrong agent looking at them.
    const prompt = buildTeamBuildPrompt(
      project,
      [],
      [teamEpic(screenshot), teamEpic(null, "Login is slow")],
      "system"
    );

    const pathAt = prompt.indexOf(absoluteUpload("abc-shot.png"));
    expect(pathAt).toBeGreaterThan(prompt.indexOf("### Epic 1:"));
    expect(pathAt).toBeLessThan(prompt.indexOf("### Epic 2:"));
    // Nested under `### Epic N`, not a sibling `##` that would close it.
    expect(prompt).toMatch(new RegExp(`^#### ${TICKET_IMAGES_HEADING}$`, "m"));
    expect(prompt).not.toMatch(
      new RegExp(`^## ${TICKET_IMAGES_HEADING}$`, "m")
    );
  });

  it("leaves a batch without screenshots byte-identical to before the feature", () => {
    const withoutFields = buildTeamBuildPrompt(
      project,
      [],
      [
        {
          title: "Board renders blank",
          description: "Opening the board shows nothing after login",
          worktreePath: "/repos/.arij-worktrees/bug-19",
          userStories: [story],
        },
      ],
      "system"
    );

    expect(buildTeamBuildPrompt(project, [], [teamEpic(null)], "system")).toBe(
      withoutFields
    );
    expect(buildTeamBuildPrompt(project, [], [teamEpic("[]")], "system")).toBe(
      withoutFields
    );
  });
});
