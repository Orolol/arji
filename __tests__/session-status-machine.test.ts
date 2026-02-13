import { describe, it, expect } from "vitest";
import {
  isValidTransition,
  assertValidTransition,
  isTerminalStatus,
  type SessionStatus,
} from "@/lib/sessions/status-machine";

describe("Session Status Machine", () => {
  describe("isValidTransition()", () => {
    it("allows pending -> running", () => {
      expect(isValidTransition("pending", "running")).toBe(true);
    });

    it("allows pending -> cancelled", () => {
      expect(isValidTransition("pending", "cancelled")).toBe(true);
    });

    it("allows pending -> failed", () => {
      expect(isValidTransition("pending", "failed")).toBe(true);
    });

    it("allows running -> completed", () => {
      expect(isValidTransition("running", "completed")).toBe(true);
    });

    it("allows running -> failed", () => {
      expect(isValidTransition("running", "failed")).toBe(true);
    });

    it("allows running -> cancelled", () => {
      expect(isValidTransition("running", "cancelled")).toBe(true);
    });

    it("rejects completed -> running (terminal state)", () => {
      expect(isValidTransition("completed", "running")).toBe(false);
    });

    it("rejects completed -> failed (terminal state)", () => {
      expect(isValidTransition("completed", "failed")).toBe(false);
    });

    it("rejects failed -> running (terminal state)", () => {
      expect(isValidTransition("failed", "running")).toBe(false);
    });

    it("rejects failed -> completed (terminal state)", () => {
      expect(isValidTransition("failed", "completed")).toBe(false);
    });

    it("rejects cancelled -> running (terminal state)", () => {
      expect(isValidTransition("cancelled", "running")).toBe(false);
    });

    it("rejects cancelled -> completed (terminal state)", () => {
      expect(isValidTransition("cancelled", "completed")).toBe(false);
    });

    it("rejects running -> pending (no backward transition)", () => {
      expect(isValidTransition("running", "pending")).toBe(false);
    });

    it("rejects same-state transitions (completed -> completed)", () => {
      expect(isValidTransition("completed", "completed")).toBe(false);
    });

    it("rejects pending -> completed (must go through running)", () => {
      expect(isValidTransition("pending", "completed")).toBe(false);
    });
  });

  describe("assertValidTransition()", () => {
    it("returns target status for valid transitions", () => {
      expect(assertValidTransition("s1", "running", "completed")).toBe("completed");
    });

    it("throws for invalid transitions with descriptive message", () => {
      expect(() => assertValidTransition("s2", "completed", "running")).toThrow(
        "Invalid session status transition for s2: completed -> running"
      );
    });
  });

  describe("isTerminalStatus()", () => {
    it("completed is terminal", () => {
      expect(isTerminalStatus("completed")).toBe(true);
    });

    it("failed is terminal", () => {
      expect(isTerminalStatus("failed")).toBe(true);
    });

    it("cancelled is terminal", () => {
      expect(isTerminalStatus("cancelled")).toBe(true);
    });

    it("pending is not terminal", () => {
      expect(isTerminalStatus("pending")).toBe(false);
    });

    it("running is not terminal", () => {
      expect(isTerminalStatus("running")).toBe(false);
    });
  });

  describe("exhaustive transition coverage", () => {
    const allStatuses: SessionStatus[] = [
      "pending",
      "running",
      "completed",
      "failed",
      "cancelled",
    ];

    it("terminal states have no valid outgoing transitions", () => {
      for (const terminal of ["completed", "failed", "cancelled"] as SessionStatus[]) {
        for (const target of allStatuses) {
          expect(isValidTransition(terminal, target)).toBe(false);
        }
      }
    });

    it("pending can only transition to running, cancelled, or failed", () => {
      const allowed = new Set<SessionStatus>(["running", "cancelled", "failed"]);
      for (const target of allStatuses) {
        expect(isValidTransition("pending", target)).toBe(allowed.has(target));
      }
    });

    it("running can only transition to completed, failed, or cancelled", () => {
      const allowed = new Set<SessionStatus>(["completed", "failed", "cancelled"]);
      for (const target of allStatuses) {
        expect(isValidTransition("running", target)).toBe(allowed.has(target));
      }
    });
  });
});
