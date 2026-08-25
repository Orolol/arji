import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  latestActivityTimestamp,
  parseStoredTimestamp,
} from "@/lib/agent-sessions/last-activity";

const originalTimezone = process.env.TZ;

describe("stored session activity timestamps", () => {
  beforeAll(() => {
    // Prove SQLite CURRENT_TIMESTAMP values stay UTC even on a non-UTC host.
    process.env.TZ = "Europe/Paris";
  });

  afterAll(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  });

  it("compares SQLite timestamps as UTC", () => {
    expect(
      latestActivityTimestamp(
        "2026-02-12T22:30:00.000Z",
        "2026-02-12 23:00:00"
      )
    ).toBe("2026-02-12T23:00:00.000Z");
    expect(parseStoredTimestamp("2026-02-12 23:00:00")).toBe(
      Date.parse("2026-02-12T23:00:00.000Z")
    );
  });

  it("ignores invalid values while retaining valid activity", () => {
    expect(
      latestActivityTimestamp(
        "not-a-timestamp",
        "2026-02-12T22:30:00.000Z"
      )
    ).toBe("2026-02-12T22:30:00.000Z");
    expect(parseStoredTimestamp("not-a-timestamp")).toBeNull();
  });

  it("returns null when no valid activity exists", () => {
    expect(latestActivityTimestamp(null, undefined, "invalid")).toBeNull();
  });
});
