import { createTranslator } from "next-intl";
import { messagesFor } from "@/lib/i18n/catalogue";

import { describe, expect, it } from "vitest";

import {
  buildChangelogPreview,
  displayVersion,
  nextPatchVersion,
  parseEpicIds,
  projectToneIndex,
  releaseState,
  ticketExclusionReason,
  upperAge,
  versionBumps,
  type ReleaseRow,
} from "@/components/releases/derive";

function release(overrides: Partial<ReleaseRow> = {}): ReleaseRow {
  return {
    id: "r1",
    version: "0.4.2",
    title: null,
    changelog: null,
    epicIds: null,
    releaseBranch: null,
    gitTag: null,
    githubReleaseId: null,
    githubReleaseUrl: null,
    pushedAt: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("nextPatchVersion", () => {
  it("bumps the patch segment", () => {
    expect(nextPatchVersion("0.4.2")).toBe("0.4.3");
  });

  it("strips a leading v", () => {
    expect(nextPatchVersion("v1.9.9")).toBe("1.9.10");
  });

  it("returns null rather than guessing", () => {
    expect(nextPatchVersion(null)).toBeNull();
    expect(nextPatchVersion(undefined)).toBeNull();
    expect(nextPatchVersion("1.0")).toBeNull();
    expect(nextPatchVersion("1.0.0.1")).toBeNull();
    expect(nextPatchVersion("abc")).toBeNull();
    expect(nextPatchVersion("")).toBeNull();
  });
});

describe("versionBumps", () => {
  it("computes all three bumps", () => {
    expect(versionBumps("0.4.2")).toEqual({
      patch: "0.4.3",
      minor: "0.5.0",
      major: "1.0.0",
    });
  });

  it("accepts a v prefix and surrounding space", () => {
    expect(versionBumps(" v2.7.4 ")).toEqual({
      patch: "2.7.5",
      minor: "2.8.0",
      major: "3.0.0",
    });
  });

  it("is null without a previous release", () => {
    expect(versionBumps(null)).toBeNull();
  });
});

describe("ticketExclusionReason", () => {
  const t = createTranslator({ locale: "en", messages: messagesFor("en"), namespace: "Releases" });
  const copy = (count: number) => t("next.storiesLeft", { count });
  it("reports the stories still open", () => {
    expect(ticketExclusionReason({ usCount: 3, usDone: 1 }, copy)).toBe(
      "2 stories left"
    );
  });

  it("uses the singular for one", () => {
    expect(ticketExclusionReason({ usCount: 2, usDone: 1 }, copy)).toBe("1 story left");
  });

  it("is null for a clean ticket", () => {
    expect(ticketExclusionReason({ usCount: 2, usDone: 2 }, copy)).toBeNull();
  });

  it("never reports 0 stories left", () => {
    expect(ticketExclusionReason({}, copy)).toBeNull();
    expect(ticketExclusionReason({ usCount: 0, usDone: 0 }, copy)).toBeNull();
    expect(ticketExclusionReason({ usCount: 1, usDone: 3 }, copy)).toBeNull();
  });
});

describe("buildChangelogPreview", () => {
  it("matches the server fallback for features only", () => {
    expect(
      buildChangelogPreview("0.4.3", null, [
        { title: "Rail dots", type: "feature" },
        { title: "Inline reply" },
      ])
    ).toBe(
      [
        "# 0.4.3",
        "",
        "## Features",
        "- Rail dots\n- Inline reply",
        "",
        "## Bugfixes",
        "- None",
        "",
        "## Breaking Changes",
        "- None",
        "",
      ].join("\n")
    );
  });

  it("matches the server fallback for bugs only", () => {
    expect(
      buildChangelogPreview("0.4.3", null, [{ title: "Fix crash", type: "bug" }])
    ).toBe(
      [
        "# 0.4.3",
        "",
        "## Features",
        "- None",
        "",
        "## Bugfixes",
        "- Fix crash",
        "",
        "## Breaking Changes",
        "- None",
        "",
      ].join("\n")
    );
  });

  it("splits a mixed selection and carries the title", () => {
    expect(
      buildChangelogPreview("1.0.0", "Piscine", [
        { title: "New desk", type: "feature" },
        { title: "Fix toast", type: "bug" },
      ])
    ).toBe(
      [
        "# 1.0.0 — Piscine",
        "",
        "## Features",
        "- New desk",
        "",
        "## Bugfixes",
        "- Fix toast",
        "",
        "## Breaking Changes",
        "- None",
        "",
      ].join("\n")
    );
  });

  it("renders all three sections when nothing is selected", () => {
    expect(buildChangelogPreview("0.1.0", "", [])).toBe(
      [
        "# 0.1.0",
        "",
        "## Features",
        "- None",
        "",
        "## Bugfixes",
        "- None",
        "",
        "## Breaking Changes",
        "- None",
        "",
      ].join("\n")
    );
  });
});

describe("upperAge", () => {
  it("uppercases only the unit word", () => {
    expect(upperAge("4d ago")).toBe("4d AGO");
    expect(upperAge("12m ago")).toBe("12m AGO");
  });

  it("uppercases just now whole", () => {
    expect(upperAge("just now")).toBe("JUST NOW");
  });

  it("renders an unknown age as an em-dash", () => {
    expect(upperAge("")).toBe("—");
  });
});

describe("displayVersion", () => {
  it("prefixes v only when absent", () => {
    expect(displayVersion("0.4.2")).toBe("v0.4.2");
    expect(displayVersion("v0.4.2")).toBe("v0.4.2");
  });
});

describe("releaseState", () => {
  it("requires both a GitHub id and a push to be published", () => {
    expect(
      releaseState(
        release({ githubReleaseId: 7, pushedAt: "2026-08-20T10:00:00.000Z" })
      )
    ).toBe("published");
  });

  it("is a draft with an id but no push", () => {
    expect(releaseState(release({ githubReleaseId: 7 }))).toBe("draft");
  });

  it("is local without a GitHub id, even when pushed", () => {
    expect(releaseState(release({ pushedAt: "2026-08-20T10:00:00.000Z" }))).toBe(
      "local"
    );
  });
});

describe("parseEpicIds", () => {
  it("reads a JSON array", () => {
    expect(parseEpicIds(release({ epicIds: '["a","b"]' }))).toEqual(["a", "b"]);
  });

  it("never throws on a malformed column", () => {
    expect(parseEpicIds(release({ epicIds: "{not json" }))).toEqual([]);
    expect(parseEpicIds(release({ epicIds: '{"a":1}' }))).toEqual([]);
    expect(parseEpicIds(release({ epicIds: null }))).toEqual([]);
    expect(parseEpicIds(null)).toEqual([]);
  });
});

describe("projectToneIndex", () => {
  it("is stable and non-negative", () => {
    const a = projectToneIndex("p1");
    expect(a).toBe(projectToneIndex("p1"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(projectToneIndex("")).toBe(0);
  });
});
