/**
 * Provider factory — returns the appropriate AgentProvider for the given type.
 *
 * Only providers with full per-spawn MCP support are registered (see
 * lib/providers/types.ts). Legacy DB rows naming a removed provider fall
 * back to claude-code through the getProvider default.
 *
 * This map is the single source of truth for which providers exist: derive
 * the list from PROVIDER_OPTIONS rather than restating it, because a private
 * copy does not fail when it drifts — it silently omits the new provider.
 *
 * A key here is not the only way a module is live. `lib/providers/pi.ts` has
 * no key and is still load-bearing: OhMyPiProvider extends it. Both facts are
 * pinned by __tests__/provider-registry-single-source.test.ts.
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
