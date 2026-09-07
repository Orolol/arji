"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import {
  BandHeader,
  Mono,
  PillButton,
  SegmentedControl,
  StrataBand,
} from "@/components/piscine";
import type { TranslationKey } from "@/lib/i18n/catalogue";
import {
  OPENAI_API_KEY_SETTING_KEY,
  OPENAI_BASE_URL_SETTING_KEY,
  OPENAI_MODEL_SETTING_KEY,
  OPENAI_REASONING_EFFORT_SETTING_KEY,
  type OpenAiReasoningEffort,
} from "@/lib/openai/constants";

import { SettingField, SettingInput } from "./SettingField";
import { SettingsSection } from "./SettingsSection";

/**
 * API OPENAI-COMPATIBLE — answer chat directly from a local or hosted
 * OpenAI-compatible endpoint, bypassing the CLI agents.
 *
 * NEVER BATCHED, and the reason is one line of the previous page worth keeping
 * whole: a blank key field means "leave the stored key alone", so the key is
 * OMITTED from the PATCH rather than sent as "". Sending it would wipe a
 * working key every time someone edited the model name. Clearing is a separate,
 * explicit action.
 */
export interface OpenAiCardProps {
  baseUrl: string;
  model: string;
  reasoning: OpenAiReasoningEffort;
  hasSavedKey: boolean;
}

/**
 * A module-scope copy table, so it holds catalogue KEY REFERENCES and the card
 * resolves them at render — `lib/i18n/catalogue.ts`, pattern 3.
 */
const EFFORTS: readonly {
  value: OpenAiReasoningEffort;
  labelKey: TranslationKey;
}[] = [
  { value: "off", labelKey: "Settings.openAi.effortOff" },
  { value: "low", labelKey: "Settings.openAi.effortLow" },
  { value: "medium", labelKey: "Settings.openAi.effortMedium" },
  { value: "high", labelKey: "Settings.openAi.effortHigh" },
];

export function OpenAiCard({
  baseUrl: loadedBaseUrl,
  model: loadedModel,
  reasoning: loadedReasoning,
  hasSavedKey,
}: OpenAiCardProps) {
  const t = useTranslations("Settings");
  // The namespace-less half: `EFFORTS` carries full dotted paths.
  const tKey = useTranslations();
  // The loaded values arrive as props once the settings read lands; a local
  // edit takes over from then on (null = "not edited yet").
  const [baseUrlEdit, setBaseUrlEdit] = useState<string | null>(null);
  const [modelEdit, setModelEdit] = useState<string | null>(null);
  const [reasoningEdit, setReasoningEdit] = useState<OpenAiReasoningEffort | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [keyCleared, setKeyCleared] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const baseUrl = baseUrlEdit ?? loadedBaseUrl;
  const model = modelEdit ?? loadedModel;
  const reasoning = reasoningEdit ?? loadedReasoning;
  const showKeyIndicator = keyCleared ? false : hasSavedKey || keySaved;

  async function save() {
    setSaving(true);
    setMessage(null);
    setError(null);

    const trimmedBaseUrl = baseUrl.trim();
    const trimmedModel = model.trim();
    if (!trimmedBaseUrl) {
      setError(t("openAi.baseUrlRequired"));
      setSaving(false);
      return;
    }
    if (!trimmedModel) {
      setError(t("openAi.modelRequired"));
      setSaving(false);
      return;
    }

    const body: Record<string, unknown> = {
      [OPENAI_BASE_URL_SETTING_KEY]: trimmedBaseUrl,
      [OPENAI_MODEL_SETTING_KEY]: trimmedModel,
      [OPENAI_REASONING_EFFORT_SETTING_KEY]: reasoning,
    };
    // Blank means "keep what is stored" — never "".
    if (apiKey.trim().length > 0) body[OPENAI_API_KEY_SETTING_KEY] = apiKey.trim();

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload?.error ?? t("openAi.saveFailed"));
        return;
      }
      if (apiKey.trim().length > 0) {
        setKeySaved(true);
        setKeyCleared(false);
      }
      setApiKey("");
      setMessage(t("openAi.saved"));
    } catch {
      setError(t("openAi.saveOffline"));
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    setClearing(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [OPENAI_API_KEY_SETTING_KEY]: "" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload?.error ?? t("openAi.clearFailed"));
        return;
      }
      setKeyCleared(true);
      setKeySaved(false);
      setApiKey("");
      setMessage(t("openAi.cleared"));
    } catch {
      setError(t("openAi.clearOffline"));
    } finally {
      setClearing(false);
    }
  }

  async function test() {
    setTesting(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/settings/openai/test", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.data?.valid) {
        setError(payload?.error ?? t("openAi.testFailed"));
        return;
      }
      const testedModel = payload?.data?.model;
      setMessage(
        testedModel
          ? t("openAi.testSucceededWithModel", { model: testedModel })
          : t("openAi.testSucceeded"),
      );
    } catch {
      setError(t("openAi.testOffline"));
    } finally {
      setTesting(false);
    }
  }

  return (
    <SettingsSection testId="openai-settings" heading={t("openAi.heading")}>
      <StrataBand stratum="card">
        <BandHeader
          stratum="card"
          label={t("openAi.label")}
          meta={
            <span className="font-sans text-[11.5px] leading-normal">
              {t("openAi.meta")}
            </span>
          }
        />

        <div className="flex flex-wrap items-end gap-[12px]">
          <SettingField
            kicker={t("openAi.baseUrl")}
            stratum="card"
            htmlFor="openai-base-url"
            flex={1.4}
            className="min-w-[220px]"
          >
            <SettingInput
              id="openai-base-url"
              data-testid="openai-base-url"
              chrome="paper"
              type="url"
              placeholder={t("openAi.baseUrlPlaceholder")}
              value={baseUrl}
              onChange={(event) => setBaseUrlEdit(event.target.value)}
            />
          </SettingField>
          <SettingField
            kicker={t("openAi.apiKey")}
            stratum="card"
            htmlFor="openai-api-key"
            flex={1}
            className="min-w-[200px]"
          >
            <SettingInput
              id="openai-api-key"
              data-testid="openai-api-key"
              chrome="paper"
              type="password"
              placeholder={t("openAi.apiKeyPlaceholder")}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </SettingField>
          <SettingField
            kicker={t("openAi.model")}
            stratum="card"
            htmlFor="openai-model"
            flex={1}
            className="min-w-[180px]"
          >
            <SettingInput
              id="openai-model"
              data-testid="openai-model"
              chrome="paper"
              placeholder={t("openAi.modelPlaceholder")}
              value={model}
              onChange={(event) => setModelEdit(event.target.value)}
            />
          </SettingField>
        </div>

        <div className="flex flex-wrap items-end gap-[12px]">
          <SettingField
            kicker={t("openAi.reasoning")}
            stratum="card"
            width={280}
            testId="openai-reasoning-effort"
          >
            <SegmentedControl<OpenAiReasoningEffort>
              chrome="bordered"
              size="md"
              options={EFFORTS.map(({ value, labelKey }) => ({
                value,
                label: tKey(labelKey),
              }))}
              value={reasoning}
              onChange={(next) => setReasoningEdit(next)}
            />
          </SettingField>
          <div className="ml-auto flex items-center gap-[10px]">
            <PillButton
              variant="outline"
              outlineTone="action"
              size="lg"
              onClick={() => void test()}
              pending={testing}
              pendingLabel={t("openAi.testing")}
            >
              {t("openAi.test")}
            </PillButton>
            <PillButton
              variant="filled"
              size="lg"
              onClick={() => void save()}
              disabled={clearing}
              pending={saving}
              pendingLabel={t("openAi.saving")}
            >
              {t("openAi.save")}
            </PillButton>
          </div>
        </div>

        {showKeyIndicator ? (
          <div className="flex items-center gap-[8px]">
            <Mono size={10.5} tone="muted">
              {t("openAi.keyAlreadySaved")}
            </Mono>
            <button
              type="button"
              data-testid="openai-clear-key-button"
              disabled={clearing || saving}
              onClick={() => void clearKey()}
              className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[10.5px] text-destructive outline-none hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
            >
              {clearing ? t("openAi.clearingKey") : t("openAi.clearKey")}
            </button>
          </div>
        ) : null}
        <div role="status" aria-live="polite" data-testid="openai-settings-message">
          {message ? (
            <Mono size={10.5} tone="muted" as="div">
              {message}
            </Mono>
          ) : null}
        </div>
        <div role="alert" data-testid="openai-settings-error">
          {error ? (
            <Mono size={10.5} tone="danger" as="div">
              {error}
            </Mono>
          ) : null}
        </div>
      </StrataBand>
    </SettingsSection>
  );
}
