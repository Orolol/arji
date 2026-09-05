"use client";

import { useEffect, useState } from "react";

import {
  GitHubCard,
  OpenAiCard,
  WebhooksBand,
  GITHUB_PAT_SETTING_KEY,
} from "@/components/settings-piscine";
import {
  GITHUB_OAUTH_META_SETTING_KEY,
  githubOAuthMetaSchema,
  type GitHubOAuthMeta,
} from "@/lib/github/oauth-meta";
import {
  OPENAI_API_KEY_SETTING_KEY,
  OPENAI_BASE_URL_SETTING_KEY,
  OPENAI_MODEL_SETTING_KEY,
  OPENAI_REASONING_EFFORT_SETTING_KEY,
  parseOpenAiReasoningEffort,
  type OpenAiReasoningEffort,
} from "@/lib/openai/constants";

/**
 * Paramètres → Intégrations.
 *
 * THE ONE TAB WITH NO SHARED FOOTER. Two of its three bands hold secrets that
 * `GET /api/settings` masks to `{hasToken:boolean}`, so there is no value to
 * put in a draft: the inputs stay empty and an indicator sentence stands in.
 * Batching them would mean either sending a blank key (wiping a working
 * credential) or sending nothing (a Save button that does not save). Each card
 * therefore keeps its own buttons and its own message, exactly as before.
 *
 * Webhooks go through their own route entirely (`PUT /api/settings/webhooks`),
 * which validates the URL and writes one project's key.
 */
interface MaskedSecret {
  hasToken?: boolean;
}

export default function IntegrationsSettingsPage() {
  const [hasGitHubToken, setHasGitHubToken] = useState(false);
  const [gitHubOAuthMeta, setGitHubOAuthMeta] = useState<GitHubOAuthMeta | null>(
    null,
  );
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [openAiBaseUrl, setOpenAiBaseUrl] = useState("");
  const [openAiModel, setOpenAiModel] = useState("");
  const [openAiReasoning, setOpenAiReasoning] =
    useState<OpenAiReasoningEffort>("off");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        const data = (payload?.data ?? {}) as Record<string, unknown>;

        setHasGitHubToken(
          Boolean((data[GITHUB_PAT_SETTING_KEY] as MaskedSecret | undefined)?.hasToken),
        );
        // Parsed with the same schema the PATCH validates against, so a
        // hand-edited row reads as "not connected" instead of rendering a
        // half-built connection card. Nothing secret lives under this key —
        // it is served in the clear next to the masked `github_pat`.
        const metaRead = githubOAuthMetaSchema.safeParse(
          data[GITHUB_OAUTH_META_SETTING_KEY],
        );
        setGitHubOAuthMeta(metaRead.success ? metaRead.data : null);

        setHasOpenAiKey(
          Boolean(
            (data[OPENAI_API_KEY_SETTING_KEY] as MaskedSecret | undefined)?.hasToken,
          ),
        );

        const baseUrl = data[OPENAI_BASE_URL_SETTING_KEY];
        if (typeof baseUrl === "string") setOpenAiBaseUrl(baseUrl);
        const model = data[OPENAI_MODEL_SETTING_KEY];
        if (typeof model === "string") setOpenAiModel(model);
        setOpenAiReasoning(
          parseOpenAiReasoningEffort(data[OPENAI_REASONING_EFFORT_SETTING_KEY]),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-[10px]">
      <GitHubCard hasSavedToken={hasGitHubToken} oauthMeta={gitHubOAuthMeta} />
      <OpenAiCard
        baseUrl={openAiBaseUrl}
        model={openAiModel}
        reasoning={openAiReasoning}
        hasSavedKey={hasOpenAiKey}
      />
      <WebhooksBand />
    </div>
  );
}
