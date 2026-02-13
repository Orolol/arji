import { describe, expect, it } from "vitest";
import { formatElapsed } from "@/lib/utils/format-elapsed";

describe("formatElapsed", () => {
  const base = new Date("2024-01-01T12:00:00Z");

  it("formats seconds under 60 as Xs", () => {
    const start = new Date("2024-01-01T11:59:45Z");
    expect(formatElapsed(start, base)).toBe("15s");
  });

  it("formats 0 seconds", () => {
    expect(formatElapsed(base, base)).toBe("0s");
  });

  it("formats exactly 1 second", () => {
    const start = new Date("2024-01-01T11:59:59Z");
    expect(formatElapsed(start, base)).toBe("1s");
  });

  it("formats minutes under 60 as Xm Ys", () => {
    const start = new Date("2024-01-01T11:55:30Z");
    expect(formatElapsed(start, base)).toBe("4m 30s");
  });

  it("formats exactly 1 minute", () => {
    const start = new Date("2024-01-01T11:59:00Z");
    expect(formatElapsed(start, base)).toBe("1m 0s");
  });

  it("formats hours as Xh Ym", () => {
    const start = new Date("2024-01-01T10:45:00Z");
    expect(formatElapsed(start, base)).toBe("1h 15m");
  });

  it("formats exactly 1 hour", () => {
    const start = new Date("2024-01-01T11:00:00Z");
    expect(formatElapsed(start, base)).toBe("1h 0m");
  });

  it("formats multiple hours", () => {
    const start = new Date("2024-01-01T09:30:00Z");
    expect(formatElapsed(start, base)).toBe("2h 30m");
  });

  it("accepts string dates", () => {
    expect(formatElapsed("2024-01-01T11:59:45Z", base)).toBe("15s");
  });

  it("uses current time when now is not provided", () => {
    // Just ensure no error; we can't know the exact elapsed
    const result = formatElapsed("2024-01-01T00:00:00Z");
    expect(result).toMatch(/^\d+[hms]/);
  });

  it("clamps negative elapsed to 0s", () => {
    const futureStart = new Date("2024-01-01T13:00:00Z");
    expect(formatElapsed(futureStart, base)).toBe("0s");
  });
});
