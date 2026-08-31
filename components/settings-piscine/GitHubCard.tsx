"use client";

import { useState } from "react";

import { BandHeader, Mono, PillButton, StrataBand } from "@/components/piscine";

import { SettingField, SettingInput } from "./SettingField";
import { SettingsSection } from "./SettingsSection";
import { GITHUB_PAT_SETTING_KEY } from "./settings-fields";

/**
 * GITHUB — the personal access token used for pull requests and release APIs.
 *
 * NEVER BATCHED. `GET /api/settings` masks the token to `{hasToken:boolean}`,
 * so there is nothing to round-trip: the input stays empty and the indicator
 * sentence stands in for the value. A draft-and-commit footer over a field
 * that is always blank would offer to save an empty secret.
 *
 * Behaviour is the previous page's, unchanged: validate hits
 * `POST /api/settings/github/validate`, save PATCHes the one key and clears
 * the input, and every message string is preserved verbatim.
 */
export interface GitHubCardProps {
  /** From the initial `GET /api/settings` read. */
  hasSavedToken: boolean;
}

export function GitHubCard({ hasSavedToken }: GitHubCardProps) {
  const [token, setToken] = useState("");
  const [savedHere, setSavedHere] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The prop lands after the settings read; a save in this session adds to it.
  // Nothing on this card clears a token, so the union is the whole truth.
  const showSavedIndicator = hasSavedToken || savedHere;

  async function validate() {
    setMessage(null);
    setError(null);
    if (!token.trim()) {
      setError("Enter a GitHub personal access token before validating.");
      return;
    }
    setValidating(true);
    try {
      const response = await fetch("/api/settings/github/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.data?.valid) {
        setError(payload?.error ?? "Token validation failed. Verify the token and retry.");
        return;
      }
      const login = payload?.data?.login;
      setMessage(
        login ? `Token is valid for GitHub account: ${login}.` : "Token is valid.",
      );
    } catch {
      setError("Could not validate token right now. Check your network and try again.");
    } finally {
      setValidating(false);
    }
  }

  async function save() {
    setMessage(null);
    setError(null);
    if (!token.trim()) {
      setError("Enter a GitHub personal access token before saving.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [GITHUB_PAT_SETTING_KEY]: token.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(
          payload?.error ?? "Failed to save GitHub token. Check the error details and retry.",
        );
        return;
      }
      setSavedHere(true);
      setToken("");
      setMessage("GitHub token saved.");
    } catch {
      setError("Failed to save GitHub token. Check your connection and retry.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection testId="github-settings" heading="GitHub">
      <StrataBand stratum="card">
        <BandHeader
          stratum="card"
          label="GitHub"
          meta={
            <span className="font-sans text-[11.5px] leading-normal">
              un token personnel pour les pull requests et l&apos;API des
              releases
            </span>
          }
        />

        <div className="flex flex-wrap items-end gap-[12px]">
          <SettingField
            kicker="GitHub PAT"
            stratum="card"
            htmlFor="github-pat"
            flex={1}
            className="min-w-[240px]"
          >
            <SettingInput
              id="github-pat"
              data-testid="github-pat"
              chrome="paper"
              type="password"
              placeholder="ghp_..."
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </SettingField>
          <PillButton
            variant="outline"
            outlineTone="action"
            size="lg"
            onClick={() => void validate()}
            pending={validating}
            pendingLabel="Validating..."
          >
            Validate Token
          </PillButton>
          <PillButton
            variant="filled"
            size="lg"
            onClick={() => void save()}
            pending={saving}
            pendingLabel="Saving..."
          >
            Save Token
          </PillButton>
        </div>

        {showSavedIndicator ? (
          <Mono size={10.5} tone="muted" as="div">
            A GitHub token is already saved for this workspace.
          </Mono>
        ) : null}
        <div role="status" aria-live="polite">
          {message ? (
            <Mono size={10.5} tone="muted" as="div">
              {message}
            </Mono>
          ) : null}
        </div>
        <div role="alert">
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
