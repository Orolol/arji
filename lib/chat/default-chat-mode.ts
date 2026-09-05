/**
 * Which mode a NEW chat conversation opens on.
 *
 * `resolveAgent("chat", …)` cannot answer this: its return type is
 * `AgentProvider`, and that union excludes `openai-compatible` and the
 * `*-persistent` modes by construction (lib/agent-config/constants.ts). The
 * ceiling was a type, not a missing dropdown entry — a fresh conversation
 * could not default to a warm CLI process however the picker was wired. This
 * resolver returns a `ChatModeProvider` instead, which lifts it.
 *
 * Order of preference, first match wins:
 *
 *   1. a persistent CLI mode whose binary is installed — a warm process is
 *      the fastest turn available and costs the user no configuration;
 *   2. the direct API, when Settings carry a base URL and a model;
 *   3. `resolveAgent("chat", projectId)` — today's behaviour, unchanged.
 *
 * Named agents are untouched: `namedAgents.provider` stays typed
 * `AgentProvider`, so a persistent mode is a conversation-level provider and
 * never an agent identity. No migration is involved.
 */

import { resolveAgent } from "@/lib/agent-config/agent-resolution";
import {
  OPENAI_COMPATIBLE_PROVIDER,
  PERSISTENT_CHAT_PROVIDER_OPTIONS,
  persistentChatBaseProvider,
  type AgentProvider,
  type ChatModeProvider,
} from "@/lib/agent-config/constants";
import { getOpenAiConfigFromSettings } from "@/lib/openai/client";
import { getProvider } from "@/lib/providers";

export interface ResolvedChatMode {
  /** Deliberately wider than `AgentProvider` — that is the whole point. */
  provider: ChatModeProvider;
  /** Only the `resolveAgent` fallback carries one; chat-only modes have none. */
  namedAgentId: string | null;
  /** Which rung answered, for callers that log or assert the decision. */
  source: "persistent-cli" | "direct-api" | "agent-resolution";
}

/**
 * The three questions the resolution asks, injectable so its unit tests can
 * answer them without a PATH, a settings table or a named-agent row.
 */
export interface ChatModeProbes {
  isCliAvailable: (provider: AgentProvider) => boolean | Promise<boolean>;
  isDirectApiConfigured: () => boolean;
  resolveChatAgent: (
    projectId?: string,
  ) => { provider: AgentProvider; namedAgentId?: string | null };
}

export const DEFAULT_CHAT_MODE_PROBES: ChatModeProbes = {
  // Same probe as GET /api/providers/available, so the default a conversation
  // opens on and the availability the picker draws cannot disagree.
  isCliAvailable: (provider) => getProvider(provider).isAvailable(),
  // "Configured" is base URL + model: the API key is optional (local servers
  // usually run without auth), so requiring it would hide a working endpoint.
  isDirectApiConfigured: () => {
    const config = getOpenAiConfigFromSettings();
    return Boolean(config.baseUrl && config.model);
  },
  resolveChatAgent: (projectId) => resolveAgent("chat", projectId),
};

/**
 * A probe that throws is a probe that answered "no". `isAvailable()` shells
 * out (`which <binary>`) and a provider may reject for its own reasons;
 * neither may turn "which mode does this conversation open on?" into a 500,
 * since every failure here has a working next rung.
 */
async function probed(run: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return await run();
  } catch {
    return false;
  }
}

export async function resolveDefaultChatMode(
  projectId?: string,
  probes: ChatModeProbes = DEFAULT_CHAT_MODE_PROBES,
): Promise<ResolvedChatMode> {
  // The preference order IS PERSISTENT_CHAT_PROVIDER_OPTIONS' order (Claude
  // Code, then Oh My Pi) rather than a second list that can drift from it;
  // __tests__/default-chat-mode.test.ts pins that the constant still reads
  // that way. Probing is sequential on purpose: first match wins, so a
  // second `which` is work nobody asked for.
  for (const persistent of PERSISTENT_CHAT_PROVIDER_OPTIONS) {
    const cli = persistentChatBaseProvider(persistent);
    if (await probed(() => probes.isCliAvailable(cli))) {
      return {
        provider: persistent,
        namedAgentId: null,
        source: "persistent-cli",
      };
    }
  }

  if (await probed(() => probes.isDirectApiConfigured())) {
    return {
      provider: OPENAI_COMPATIBLE_PROVIDER,
      namedAgentId: null,
      source: "direct-api",
    };
  }

  const resolved = probes.resolveChatAgent(projectId);
  return {
    provider: resolved.provider,
    namedAgentId: resolved.namedAgentId ?? null,
    source: "agent-resolution",
  };
}
