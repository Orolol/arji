"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy } from "lucide-react";

import {
  BandHeader,
  Mono,
  PillButton,
  QuietDangerAction,
  StrataBand,
  pillButtonVariants,
} from "@/components/piscine";
import { useGitHubDeviceFlow } from "@/hooks/useGitHubDeviceFlow";
import {
  GITHUB_OAUTH_META_SETTING_KEY,
  type GitHubOAuthMeta,
} from "@/lib/github/oauth-meta";

import { SettingField, SettingInput } from "./SettingField";
import { SettingsSection } from "./SettingsSection";
import { GITHUB_PAT_SETTING_KEY } from "./settings-fields";

/**
 * GITHUB — how Arij authenticates to GitHub for pull requests, issues and
 * release APIs.
 *
 * TWO WAYS IN, ONE STORED TOKEN. "Se connecter avec GitHub" runs the OAuth
 * Device Flow (`hooks/useGitHubDeviceFlow.ts`); the PAT field below it stays as
 * the fallback for anyone who cannot or will not use it. BOTH write the same
 * `settings.github_pat` — that is the design decision the whole epic rests on,
 * and why clone, PR, issue and release code needed no change. `github_oauth_meta`
 * is the secret-free sibling recording WHO the token belongs to and WHERE it
 * came from, which is the only thing this card renders differently per path.
 *
 * NEVER BATCHED. `GET /api/settings` masks the token to `{hasToken:boolean}`,
 * so there is nothing to round-trip: the input stays empty and the connection
 * panel stands in for the value. A draft-and-commit footer over a field that is
 * always blank would offer to save an empty secret.
 *
 * The manual path's behaviour is the previous page's, unchanged, down to the
 * message strings: validate hits `POST /api/settings/github/validate`, save
 * PATCHes the token and clears the input. What it gained is the meta write —
 * `tokenSource: "manual"`, so a hand-pasted token cannot leave a stale
 * "connecté en tant que @someone-else" behind it.
 */
export interface GitHubCardProps {
  /** From the initial `GET /api/settings` read. */
  hasSavedToken: boolean;
  /** `settings.github_oauth_meta` from the same read, or null when unset. */
  oauthMeta?: GitHubOAuthMeta | null;
}

/** How long the "Copié" acknowledgement stays up. */
const COPIED_RESET_MS = 1600;

function formatObtainedAt(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";
  return new Date(parsed).toLocaleDateString();
}

export function GitHubCard({ hasSavedToken, oauthMeta = null }: GitHubCardProps) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // The props carry what the settings read found; an action ON THIS CARD then
  // takes over. `null`/`undefined` mean "nothing happened here yet, follow the
  // prop" — which is what lets Déconnecter turn a `true` prop back off without
  // the parent re-reading.
  const [tokenOverride, setTokenOverride] = useState<boolean | null>(null);
  const [metaOverride, setMetaOverride] = useState<
    GitHubOAuthMeta | null | undefined
  >(undefined);

  const hasToken = tokenOverride ?? hasSavedToken;
  const meta = metaOverride === undefined ? oauthMeta : metaOverride;

  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    []
  );

  const flow = useGitHubDeviceFlow((connected) => {
    // The poll route has already written both keys; this only tells the card.
    setTokenOverride(true);
    setMetaOverride(connected);
    setError(null);
    // Deliberately NOT the panel's own sentence: the connection card right
    // above already names the account, and repeating it verbatim reads as two
    // different facts. This line exists for the live region — it announces the
    // TRANSITION, which a screen reader would otherwise have to infer from a
    // panel that silently swapped.
    setMessage("Connexion GitHub réussie.");
  });

  async function copyUserCode(userCode: string) {
    try {
      await navigator.clipboard.writeText(userCode);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      // Clipboard denied (insecure context, permissions). The code is printed
      // right there in full — the fallback that always works is reading it.
    }
  }

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

  /**
   * Resolve who a hand-pasted token belongs to, so the connection panel can
   * name them. BEST EFFORT BY CONSTRUCTION: a failure returns `null`, which is
   * a valid value for the key (it clears any stale connection) and therefore
   * cannot turn an identity lookup into a failed token save.
   *
   * `scopes` stays empty because `POST /api/settings/github/validate` does not
   * report them — empty means unknown here, and the panel prints nothing
   * rather than claiming a narrower grant than the token really has.
   */
  async function resolveManualMeta(pat: string): Promise<GitHubOAuthMeta | null> {
    try {
      const response = await fetch("/api/settings/github/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: pat }),
      });
      const payload = await response.json().catch(() => ({}));
      const login =
        typeof payload?.data?.login === "string" ? payload.data.login.trim() : "";
      if (!response.ok || !payload?.data?.valid || !login) return null;

      return {
        login,
        scopes: [],
        obtainedAt: new Date().toISOString(),
        tokenSource: "manual",
      };
    } catch {
      return null;
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
      const trimmed = token.trim();
      const manualMeta = await resolveManualMeta(trimmed);

      // ONE PATCH, both keys. The route validates every key before writing
      // any, and both shapes `resolveManualMeta` can return are valid, so the
      // meta can never be the reason a token fails to save.
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [GITHUB_PAT_SETTING_KEY]: trimmed,
          [GITHUB_OAUTH_META_SETTING_KEY]: manualMeta,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(
          payload?.error ?? "Failed to save GitHub token. Check the error details and retry.",
        );
        return;
      }
      // A hand-pasted token supersedes whatever the device flow left behind,
      // so any running sign-in is now pointing at a token nobody wants.
      flow.cancel();
      setTokenOverride(true);
      setMetaOverride(manualMeta);
      setToken("");
      setMessage("GitHub token saved.");
    } catch {
      setError("Failed to save GitHub token. Check your connection and retry.");
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    setMessage(null);
    setError(null);
    setDisconnecting(true);
    try {
      // Both keys, together: a cleared token with surviving meta would render
      // as a connection that cannot make a single API call.
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [GITHUB_PAT_SETTING_KEY]: "",
          [GITHUB_OAUTH_META_SETTING_KEY]: null,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(
          payload?.error ?? "Failed to disconnect GitHub. Check the error details and retry.",
        );
        return;
      }
      flow.cancel();
      setTokenOverride(false);
      setMetaOverride(null);
      setMessage("GitHub déconnecté.");
    } catch {
      setError("Failed to disconnect GitHub. Check your connection and retry.");
    } finally {
      setDisconnecting(false);
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
              pour les pull requests, les issues et l&apos;API des releases
            </span>
          }
        />

        {renderConnection()}

        <div className="flex flex-col gap-[8px] border-t border-border pt-[12px]">
          <Mono size={10.5} tone="muted" as="div">
            Ou collez un token personnel à la main.
          </Mono>

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
            {/* Neither is filled any more: the card's ONE filled slot is
                "Se connecter avec GitHub". Within the fallback, save still
                outranks validate — action outline over neutral. */}
            <PillButton
              variant="outline"
              outlineTone="neutral"
              size="lg"
              onClick={() => void validate()}
              pending={validating}
              pendingLabel="Validating..."
            >
              Validate Token
            </PillButton>
            <PillButton
              variant="outline"
              outlineTone="action"
              size="lg"
              onClick={() => void save()}
              pending={saving}
              pendingLabel="Saving..."
            >
              Save Token
            </PillButton>
          </div>
        </div>

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

  /**
   * The connection region, in precedence order. A sign-in the user is in the
   * middle of outranks the stored state: they can see the code they are typing
   * even while an old token is still on disk.
   */
  function renderConnection() {
    if (flow.state.status === "awaiting") {
      const { userCode, verificationUri } = flow.state;
      return (
        <div
          data-testid="github-device-flow"
          className="flex flex-col gap-[10px]"
        >
          <Mono size={10.5} tone="muted" as="div">
            1. Copiez ce code · 2. ouvrez GitHub · 3. collez-le pour autoriser
            Arij.
          </Mono>

          <div className="flex flex-wrap items-center gap-[10px]">
            <span
              data-testid="github-device-code"
              className="rounded-[10px] border-[1.5px] border-input bg-field px-[12px] py-[7px] font-mono text-[18px] font-bold tracking-[0.18em] tabular-nums text-foreground"
            >
              {userCode}
            </span>
            <PillButton
              variant="outline"
              outlineTone="neutral"
              size="lg"
              icon={copied ? Check : Copy}
              onClick={() => void copyUserCode(userCode)}
              data-testid="github-device-copy"
            >
              {copied ? "Copié" : "Copier le code"}
            </PillButton>
            <a
              href={verificationUri}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="github-device-link"
              className={pillButtonVariants({ variant: "filled", size: "lg" })}
            >
              <ArrowUpRight size={13} aria-hidden="true" />
              Ouvrir GitHub
            </a>
          </div>

          <div className="flex items-center gap-[12px]">
            {/* aria-live so a screen reader learns the flow is waiting on the
                user, not on the network. */}
            <div role="status" aria-live="polite">
              <Mono size={10.5} tone="muted" as="div">
                En attente de votre autorisation sur GitHub…
              </Mono>
            </div>
            {/* QuietDangerAction forwards no `data-testid` — it has no
                `...rest`. Its label IS its handle, here and below. */}
            <QuietDangerAction size={11.5} onClick={() => flow.cancel()}>
              Annuler
            </QuietDangerAction>
          </div>
        </div>
      );
    }

    if (flow.state.status === "failed") {
      return (
        <div data-testid="github-flow-error" className="flex flex-col gap-[10px]">
          <div role="alert">
            <Mono size={10.5} tone="danger" as="div">
              {flow.state.message}
            </Mono>
          </div>
          <div>
            <PillButton
              variant="filled"
              size="lg"
              onClick={() => flow.start()}
              data-testid="github-flow-retry"
            >
              Réessayer
            </PillButton>
          </div>
        </div>
      );
    }

    if (hasToken && meta) {
      const obtainedAt = formatObtainedAt(meta.obtainedAt);
      return (
        <div data-testid="github-connected" className="flex flex-col gap-[8px]">
          <Mono size={12} tone="ink" as="div">
            {`Connecté en tant que ${meta.login}`}
          </Mono>
          <Mono size={10.5} tone="muted" as="div">
            {[
              meta.tokenSource === "oauth_device"
                ? "via GitHub"
                : "token personnel",
              meta.scopes.length > 0 ? meta.scopes.join(", ") : null,
              obtainedAt ? `depuis le ${obtainedAt}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Mono>
          <div>
            <QuietDangerAction onClick={() => void disconnect()}>
              {disconnecting ? "Déconnexion…" : "Déconnecter"}
            </QuietDangerAction>
          </div>
        </div>
      );
    }

    if (hasToken) {
      // A token from before this epic, or one whose identity GitHub would not
      // confirm. Nothing to name, but it is still a connection to sever.
      return (
        <div data-testid="github-connected" className="flex flex-col gap-[8px]">
          <Mono size={10.5} tone="muted" as="div">
            A GitHub token is already saved for this workspace.
          </Mono>
          <div>
            <QuietDangerAction onClick={() => void disconnect()}>
              {disconnecting ? "Déconnexion…" : "Déconnecter"}
            </QuietDangerAction>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-wrap items-center gap-[12px]">
        <PillButton
          variant="filled"
          size="lg"
          onClick={() => flow.start()}
          pending={flow.state.status === "starting"}
          pendingLabel="Connexion…"
          data-testid="github-connect"
        >
          Se connecter avec GitHub
        </PillButton>
        <Mono size={10.5} tone="muted" as="div">
          Arij vous montre un code à saisir sur github.com — aucun token à
          copier.
        </Mono>
      </div>
    );
  }
}
