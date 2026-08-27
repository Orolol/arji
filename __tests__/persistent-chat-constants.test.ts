import { describe, expect, it } from "vitest";
import {
  parsePersistentChatCapSetting,
  parsePersistentChatDurationSetting,
  PERSISTENT_CHAT_IDLE_TIMEOUT_SETTING,
  PERSISTENT_CHAT_MAX_CONVERSATIONS_SETTING,
  PERSISTENT_CHAT_TURN_STALL_SETTING,
} from "@/lib/chat/persistent-chat-constants";

describe("parsePersistentChatDurationSetting", () => {
  it("accepts a JSON-encoded number, a bare string, and a number", () => {
    expect(parsePersistentChatDurationSetting("900000", 1)).toBe(900_000);
    expect(parsePersistentChatDurationSetting('"900000"', 1)).toBe(900_000);
    expect(parsePersistentChatDurationSetting(900_000, 1)).toBe(900_000);
  });

  it("floors fractional values", () => {
    expect(parsePersistentChatDurationSetting("1500.9", 1)).toBe(1500);
  });

  it.each([
    ["unset", undefined],
    ["null", null],
    ["empty", ""],
    ["non-numeric", "soon"],
    ["zero", "0"],
    ["negative", "-1"],
    ["infinite", "1e999"],
  ])("falls back on %s", (_label, value) => {
    // Zero is deliberately a fallback, not "unlimited": a zero-length
    // deadline would reap every process the moment it went idle.
    expect(parsePersistentChatDurationSetting(value, 900_000)).toBe(900_000);
  });
});

describe("parsePersistentChatCapSetting", () => {
  it("accepts a positive cap", () => {
    expect(parsePersistentChatCapSetting("1", 3)).toBe(1);
    expect(parsePersistentChatCapSetting(7, 3)).toBe(7);
  });

  it.each([
    ["zero", "0"],
    ["negative", "-2"],
    ["fractional below one", "0.5"],
    ["non-numeric", "lots"],
    ["unset", undefined],
  ])("falls back on %s rather than going unbounded", (_label, value) => {
    // Unlike the scheduler's concurrency cap, 0 is not "unlimited" here:
    // every warm conversation pins a CLI process worth hundreds of MB.
    expect(parsePersistentChatCapSetting(value, 3)).toBe(3);
  });
});

describe("setting keys", () => {
  it("are the strings the chat stream route reads", () => {
    expect(PERSISTENT_CHAT_IDLE_TIMEOUT_SETTING).toBe(
      "chat_persistent_idle_timeout_ms",
    );
    expect(PERSISTENT_CHAT_MAX_CONVERSATIONS_SETTING).toBe(
      "chat_persistent_max_conversations",
    );
    expect(PERSISTENT_CHAT_TURN_STALL_SETTING).toBe(
      "chat_persistent_turn_stall_ms",
    );
  });
});
