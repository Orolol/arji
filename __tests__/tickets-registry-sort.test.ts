import { describe, expect, it } from "vitest";
import { sortRegistryRows } from "@/lib/tickets-registry/sort";
import type { RegistryRow } from "@/lib/tickets-registry/types";

describe("registry comparator", () => {
  it.each(["asc", "desc"] as const)("keeps missing values last in %s order, breaks ties and leaves the input intact", (direction) => {
    const rows = [
      { epicId: "null", costUsd: null }, { epicId: "b", costUsd: 0 }, { epicId: "a", costUsd: 0 },
    ] as RegistryRow[];
    expect(sortRegistryRows(rows, "cout", direction).map((row) => row.epicId)).toEqual(["a", "b", "null"]);
    expect(rows[0].epicId).toBe("null");
  });

  it("compares real timestamps across timestamp formats, not relative activity labels", () => {
    const rows = [
      { epicId: "early", activityAt: "2026-09-05T08:00:00Z", activity: "updated · 2h ago" },
      { epicId: "late", activityAt: "2026-09-05 09:00:00", activity: "updated · 1h ago" },
    ] as RegistryRow[];
    expect(sortRegistryRows(rows, "activite", "desc").map((row) => row.epicId)).toEqual(["late", "early"]);
  });
});
