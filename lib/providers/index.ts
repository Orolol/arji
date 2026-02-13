/**
 * Provider factory — returns the appropriate AgentProvider for the given type.
 */

import type { AgentProvider, ProviderType } from "./types";
import { ClaudeCodeProvider } from "./claude-code";
import { CodexProvider } from "./codex";
import { GeminiCliProvider } from "./gemini-cli";

const providers: Record<ProviderType, AgentProvider> = {
  "claude-code": new ClaudeCodeProvider(),
  codex: new CodexProvider(),
  "gemini-cli": new GeminiCliProvider(),
};

/**
 * Get the provider instance for the given type.
 * Defaults to 'claude-code' if the type is not recognized.
 */
export function getProvider(type: ProviderType = "claude-code"): AgentProvider {
  return providers[type] ?? providers["claude-code"];
}

export type { AgentProvider, ProviderType, ProviderSpawnOptions, ProviderSession, ProviderResult } from "./types";
