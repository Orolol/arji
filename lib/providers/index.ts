/**
 * Provider factory — returns the appropriate AgentProvider for the given type.
 *
 * Only providers with full per-spawn MCP support are registered (see
 * lib/providers/types.ts). Legacy DB rows naming a removed provider fall
 * back to claude-code through the getProvider default.
 */

import type { AgentProvider, ProviderType } from "./types";
import { ClaudeCodeProvider } from "./claude-code";
import { CodexProvider } from "./codex";
import { OhMyPiProvider } from "./oh-my-pi";
import { AgyProvider } from "./agy";

const providers: Record<ProviderType, AgentProvider> = {
  "claude-code": new ClaudeCodeProvider(),
  codex: new CodexProvider(),
  "oh-my-pi": new OhMyPiProvider(),
  agy: new AgyProvider(),
};

/**
 * Get the provider instance for the given type.
 * Defaults to 'claude-code' if the type is not recognized.
 */
export function getProvider(type: ProviderType = "claude-code"): AgentProvider {
  return providers[type] ?? providers["claude-code"];
}

export type { AgentProvider, ProviderType, ProviderSpawnOptions, ProviderSession, ProviderResult } from "./types";
