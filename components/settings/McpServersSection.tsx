"use client";

import { useLocale, useTranslations } from "next-intl";
import { formatDateTime } from "@/lib/i18n/format";
import type { UiLocale } from "@/lib/i18n/locales";
/**
 * "MCP servers" settings surface, used at BOTH scopes.
 *
 * `projectId === null` renders the global list (app/settings); a project id
 * renders that project's own servers plus the globals it inherits, read-only,
 * with the two ways to override one: disable it locally, or create a local
 * entry of the same name (a project entry shadows a global).
 *
 * Two contracts this component exists to honour, both easy to get wrong:
 *
 *   1. **Secrets are write-only.** The API returns "***" for every `env` /
 *      `header` value, never the value. So the secrets box starts EMPTY on
 *      edit, and an empty field means "keep what is stored" — never "clear
 *      it", which is why `handleSave` OMITS the key rather than sending `{}`
 *      (`mergeSecretMap` walks the patch it is given, so `{}` erases).
 *      Rendering the mask into the field would save the literal string "***"
 *      the moment the user touched anything else.
 *
 *      The field is a `<textarea>` — several `KEY=value` lines at once — so it
 *      cannot carry `type="password"`. It is password-CLASS by behaviour, not
 *      by input type: never pre-filled, never echoed back, blank preserves.
 *
 *   2. **Length caps are mirrored, not re-invented.** Every `maxLength` here
 *      comes from the same constant the service validates against, so the form
 *      cannot accept something the API will reject. The server still rejects
 *      over-length input explicitly rather than truncating it; this is the
 *      other half of that rule, not a replacement for it.
 *
 *      The four single-value fields (name, command, url, usage hint) carry one
 *      because their cap is 1:1 with the field. The multi-line ones — args,
 *      agent types, allowed tools, secrets — deliberately do NOT, and that is
 *      a decision rather than an omission: each of their caps is per-ITEM
 *      (`MCP_SERVER_ARG_MAX_LENGTH` per line, `MCP_SERVER_ENV_VALUE_MAX_LENGTH`
 *      per value), which a single textarea-wide `maxLength` cannot express.
 *      Spending the args cap on the textarea would be actively wrong, since
 *      `MCP_SERVER_ARGS_MAX_TOTAL_LENGTH` is measured over the JSON encoding
 *      — quotes, commas and brackets included — and so does not correspond to
 *      any count of the raw characters typed here. These fields are left to
 *      the server's explicit rejection, which reports the offending limit.
 *
 * COPY LIVES IN THE CATALOGUE, under the `SettingsLegacy` namespace — this is
 * the OLDER settings surface, distinct from `components/settings-piscine/`,
 * which owns `Settings`. `healthLabel` composes a display string outside
 * React, so it takes the RESOLVED PHRASES from its caller rather than a
 * translator: every key stays a literal next to the `useTranslations` binding
 * (`lib/i18n/catalogue.ts`, pattern 3).
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  MCP_SERVER_COMMAND_MAX_LENGTH,
  MCP_SERVER_NAME_MAX_LENGTH,
  MCP_SERVER_URL_MAX_LENGTH,
  MCP_SERVER_USAGE_HINT_MAX_LENGTH,
  type McpServerView,
} from "@/lib/mcp/server-limits";

interface InheritedServer extends McpServerView {
  /** True when a project entry of the same name overrides this global. */
  shadowed: boolean;
}

interface ProjectPayload {
  servers: McpServerView[];
  inherited: InheritedServer[];
  unsupportedProviders: string[];
}

/** Draft state for the add/edit form. Secrets are entered as `KEY=value` lines. */
interface Draft {
  id: string | null;
  name: string;
  transport: "stdio" | "http";
  /**
   * The transport the row had when editing started, or null on create. A save
   * needs to distinguish "switched transport" (clear the other side's stored
   * fields) from "edited something else" (leave them alone).
   */
  originalTransport: "stdio" | "http" | null;
  command: string;
  args: string;
  url: string;
  usageHint: string;
  secrets: string;
  /** Newline-separated agent types; blank = every type (stored as NULL). */
  agentTypes: string;
  /** Newline-separated bare tool names; blank = every tool the server exposes. */
  toolAllowlist: string;
  enabled: boolean;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  transport: "stdio",
  originalTransport: null,
  command: "",
  args: "",
  url: "",
  usageHint: "",
  secrets: "",
  agentTypes: "",
  toolAllowlist: "",
  enabled: true,
};

/**
 * Parses the `KEY=value` textarea into a map.
 *
 * "Leave it blank to keep it" is enforced by the CALLER, not here: a blank
 * textarea must make the secret key absent from the payload entirely. Sending
 * `{}` is NOT the same thing — `mergeSecretMap` iterates the patch it is given,
 * so an empty map erases every stored value rather than preserving them.
 */
function parseSecretLines(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    map[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return map;
}

/**
 * Newline list -> array, or NULL when blank.
 *
 * NULL and [] mean different things in these two columns: `agent_types` NULL is
 * "every agent type", while an empty array would match nothing and silently
 * keep the server out of every session. Same for `tool_allowlist`, where NULL
 * is "every tool the server exposes".
 */
function parseListLines(text: string): string[] | null {
  const items = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

/**
 * The stored secret KEYS for a server's transport. Values are masked by the
 * API and never appear here; the keys are what make "this server has
 * credentials configured" legible on the list.
 */
function secretKeys(server: McpServerView): string[] {
  return Object.keys(server.transport === "http" ? server.headers : server.env);
}

/** The three phrases `healthLabel` picks between, already resolved. */
interface HealthCopy {
  neverTested: string;
  ok: (when: string) => string;
  failed: (when: string) => string;
}

function healthLabel(
  server: McpServerView,
  locale: UiLocale,
  copy: HealthCopy,
): {
  text: string;
  variant: "secondary" | "destructive" | "outline";
} {
  if (server.lastCheckOk === null || server.lastCheckedAt === null) {
    return { text: copy.neverTested, variant: "outline" };
  }
  const when = formatDateTime(server.lastCheckedAt, { locale, style: "dateTimeSeconds" });
  return server.lastCheckOk
    ? { text: copy.ok(when), variant: "secondary" }
    : { text: copy.failed(when), variant: "destructive" };
}

export function McpServersSection({ projectId }: { projectId?: string | null }) {
  const locale = useLocale();
  const t = useTranslations("SettingsLegacy");
  const scopedProjectId = projectId ?? null;
  const baseUrl = scopedProjectId
    ? `/api/projects/${scopedProjectId}/mcp-servers`
    : "/api/settings/mcp-servers";

  const [servers, setServers] = useState<McpServerView[]>([]);
  const [inherited, setInherited] = useState<InheritedServer[]>([]);
  const [unsupportedProviders, setUnsupportedProviders] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(baseUrl);
      const body = await response.json();
      if (!response.ok) {
        setMessage(body.error ?? t("message.loadFailed"));
        return;
      }
      // Shape-check before setting state. This section is one of a dozen on a
      // shared settings page: an unexpected payload must degrade to an empty
      // list, not throw during render and blank every OTHER section with it.
      const asList = (value: unknown): McpServerView[] =>
        Array.isArray(value) ? (value as McpServerView[]) : [];
      if (scopedProjectId) {
        const data = (body.data ?? {}) as Partial<ProjectPayload>;
        setServers(asList(data.servers));
        setInherited(asList(data.inherited) as InheritedServer[]);
        setUnsupportedProviders(
          Array.isArray(data.unsupportedProviders)
            ? data.unsupportedProviders
            : [],
        );
      } else {
        setServers(asList(body.data));
      }
    } catch {
      setMessage(t("message.loadFailed"));
    }
  }, [baseUrl, scopedProjectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(
    url: string,
    method: string,
    payload?: unknown,
  ): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(url, {
        method,
        headers: payload ? { "Content-Type": "application/json" } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
      });
      const body = await response.json();
      if (!response.ok) {
        // The API returns ONE error shape whether the value broke a length cap,
        // an enum, or the transport rules — so there is one alert here, not a
        // special case per field.
        setMessage(body.error ?? t("message.requestFailed"));
        return false;
      }
      await load();
      return true;
    } catch {
      setMessage(t("message.requestFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!draft) return;
    const isStdio = draft.transport === "stdio";
    const payload: Record<string, unknown> = {
      name: draft.name.trim(),
      transport: draft.transport,
      enabled: draft.enabled,
      usageHint: draft.usageHint.trim() || null,
      agentTypes: parseListLines(draft.agentTypes),
      toolAllowlist: parseListLines(draft.toolAllowlist),
    };

    // PATCH is a merge, so the fields belonging to the OTHER transport have to
    // be cleared explicitly. Leaving them behind makes the merged row
    // transport-inconsistent and the API rejects the save naming a field the
    // form has just stopped rendering — with no affordance to fix it.
    if (isStdio) {
      payload.command = draft.command.trim();
      payload.args = draft.args
        .split("\n")
        .map((a) => a.trim())
        .filter(Boolean);
      payload.url = null;
    } else {
      payload.url = draft.url.trim();
      payload.command = null;
      payload.args = null;
    }

    // A blank secrets box means "keep what is stored", which requires OMITTING
    // the key: `mergeSecretMap` walks the patch it receives, so `{}` would
    // erase every stored value instead of preserving it.
    const secretsText = draft.secrets.trim();
    if (secretsText) {
      payload[isStdio ? "env" : "headers"] = parseSecretLines(secretsText);
    }

    // Switching transport makes the other side's credentials dead config for
    // this server. Clear them rather than leaving a live secret in the row —
    // but only on an actual switch, so an ordinary edit never drops anything.
    if (draft.originalTransport && draft.originalTransport !== draft.transport) {
      payload[isStdio ? "headers" : "env"] = {};
    }

    const ok = draft.id
      ? await send(`${baseUrl}/${draft.id}`, "PATCH", payload)
      : await send(baseUrl, "POST", payload);
    if (ok) setDraft(null);
  }

  async function handleTest(serverId: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`${baseUrl}/${serverId}/test`, {
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage(body.error ?? t("message.testFailed"));
        return;
      }
      const result = body.data as {
        ok: boolean;
        toolCount: number;
        toolNames: string[];
        error: string | null;
      };
      setMessage(
        result.ok
          ? t("message.testConnected", {
              count: result.toolCount,
              tools: result.toolNames.join(", ") || t("message.testNoTools"),
            })
          : t("message.testRefused", {
              reason: result.error ?? t("message.testNoReason"),
            }),
      );
      await load();
    } catch {
      setMessage(t("message.testFailed"));
    } finally {
      setBusy(false);
    }
  }

  const healthCopy: HealthCopy = {
    neverTested: t("health.neverTested"),
    ok: (when) => t("health.ok", { when }),
    failed: (when) => t("health.failed", { when }),
  };

  function startEdit(server: McpServerView) {
    setDraft({
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.command ?? "",
      args: server.args.join("\n"),
      url: server.url ?? "",
      usageHint: server.usageHint ?? "",
      // Deliberately EMPTY: the API never hands back a secret, and rendering
      // the "***" mask here would save that literal string on the next PATCH.
      secrets: "",
      agentTypes: (server.agentTypes ?? []).join("\n"),
      toolAllowlist: (server.toolAllowlist ?? []).join("\n"),
      enabled: server.enabled,
      originalTransport: server.transport,
    });
  }

  return (
    <section
      className="space-y-3 rounded-md border border-border p-4"
      data-testid="mcp-servers-section"
    >
      <div>
        <h2 className="text-lg font-semibold">{t("mcp.heading")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("mcp.intro")}{" "}
          {scopedProjectId ? t("mcp.scopeProject") : t("mcp.scopeGlobal")}{" "}
          {t.rich("mcp.strictConfig", {
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
        {/* Stated rather than left to be discovered: the fast chat mode is an
            HTTP chat endpoint, not an MCP host, so nothing declared here can
            reach it. Without this line its absence reads as a broken server. */}
        <p className="mt-1 text-xs text-muted-foreground">
          {t("mcp.notChatMode")}
        </p>
      </div>

      <ul className="space-y-2" data-testid="mcp-servers-list">
        {servers.length === 0 && (
          <li className="text-sm text-muted-foreground">
            {scopedProjectId ? t("mcp.emptyProject") : t("mcp.emptyGlobal")}
          </li>
        )}
        {servers.map((server) => {
          const health = healthLabel(server, locale, healthCopy);
          return (
            <li
              key={server.id}
              className="flex flex-wrap items-center gap-2 rounded border border-border p-2 text-sm"
              data-testid={`mcp-server-${server.name}`}
            >
              <span className="font-medium">{server.name}</span>
              <Badge variant="outline">{server.transport}</Badge>
              {!server.enabled && (
                <Badge variant="outline">{t("server.disabled")}</Badge>
              )}
              <Badge variant={health.variant}>{health.text}</Badge>
              {/* Rendered so a typo ("reviewer" for "review_security") shows up
                  here instead of silently never injecting anywhere. */}
              {server.agentTypes && server.agentTypes.length > 0 && (
                <Badge
                  variant="outline"
                  data-testid={`mcp-server-agent-types-${server.name}`}
                >
                  {t("server.agentTypes", { list: server.agentTypes.join(", ") })}
                </Badge>
              )}
              {server.toolAllowlist && server.toolAllowlist.length > 0 && (
                <Badge
                  variant="outline"
                  data-testid={`mcp-server-tools-${server.name}`}
                >
                  {t("server.tools", { list: server.toolAllowlist.join(", ") })}
                </Badge>
              )}
              {/* KEYS only — the API masks every value, so this leaks nothing.
                  Without it, "has credentials" is invisible: a shadow row
                  created by "Disable for this project" deliberately carries
                  none, and the one-click Enable next to it would otherwise
                  start a credential-less server with no hint as to why it
                  fails. */}
              {secretKeys(server).length > 0 && (
                <Badge
                  variant="outline"
                  data-testid={`mcp-server-secret-keys-${server.name}`}
                >
                  {t("server.secrets", { list: secretKeys(server).join(", ") })}
                </Badge>
              )}
              {server.usageHint && (
                <span className="text-muted-foreground">{server.usageHint}</span>
              )}
              {/* The stored reason, not just the stored verdict. The probe
                  goes to the trouble of recovering a failing server's own
                  diagnostic (lib/mcp/probe.ts); showing it only in the
                  transient message below would lose it on the next reload and
                  leave a bare "Failed — <date>" that names no cause. */}
              {server.lastCheckOk === false && server.lastCheckError && (
                <span
                  className="w-full break-words text-xs text-destructive"
                  data-testid={`mcp-server-check-error-${server.name}`}
                >
                  {server.lastCheckError}
                </span>
              )}
              <span className="ml-auto flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => handleTest(server.id)}
                >
                  {t("server.test")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => startEdit(server)}
                >
                  {t("server.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    send(`${baseUrl}/${server.id}`, "PATCH", {
                      enabled: !server.enabled,
                    })
                  }
                >
                  {server.enabled ? t("server.disable") : t("server.enable")}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => send(`${baseUrl}/${server.id}`, "DELETE")}
                >
                  {t("server.delete")}
                </Button>
              </span>
              {scopedProjectId && unsupportedProviders.length > 0 && (
                // Story requirement: the scope limitation is READ off the
                // screen, never inferred. These CLIs only read a user-global
                // MCP registry, so a project-scoped server cannot reach them.
                <span
                  className="w-full text-xs text-muted-foreground"
                  data-testid={`mcp-server-unsupported-${server.name}`}
                >
                  {t("server.unsupportedProviders", {
                    providers: unsupportedProviders.join(", "),
                  })}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {scopedProjectId && (
        <div className="space-y-2" data-testid="mcp-inherited-list">
          <h3 className="text-sm font-semibold">{t("inherited.heading")}</h3>
          {inherited.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("inherited.empty")}
            </p>
          )}
          {inherited.map((server) => (
            <div
              key={server.id}
              className="flex flex-wrap items-center gap-2 rounded border border-dashed border-border bg-muted/30 p-2 text-sm"
              data-testid={`mcp-inherited-${server.name}`}
            >
              <span className="font-medium">{server.name}</span>
              <Badge variant="outline">{t("inherited.badge")}</Badge>
              {server.shadowed && (
                // An override is a PROJECT row, and a project row cannot reach a
                // user-global provider — so those CLIs keep loading the global.
                // An unqualified "overridden here" would state the opposite of
                // what actually happens on two of the four providers.
                <Badge variant="secondary">
                  {unsupportedProviders.length > 0
                    ? t("inherited.overriddenExcept", {
                        providers: unsupportedProviders.join(", "),
                      })
                    : t("inherited.overridden")}
                </Badge>
              )}
              {server.usageHint && (
                <span className="text-muted-foreground">{server.usageHint}</span>
              )}
              <span className="ml-auto">
                {!server.shadowed && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      send(`${baseUrl}/shadow`, "POST", {
                        globalServerId: server.id,
                      })
                    }
                  >
                    {t("inherited.disableForProject")}
                  </Button>
                )}
              </span>
              {!server.shadowed && unsupportedProviders.length > 0 && (
                <span
                  className="w-full text-xs text-muted-foreground"
                  data-testid={`mcp-inherited-partial-${server.name}`}
                >
                  {t("inherited.partialDisable", {
                    providers: unsupportedProviders.join(", "),
                  })}
                </span>
              )}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{t("inherited.note")}</p>
        </div>
      )}

      {draft === null ? (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => setDraft({ ...EMPTY_DRAFT })}
        >
          {t("form.add")}
        </Button>
      ) : (
        <div
          className="space-y-2 rounded border border-border p-3"
          data-testid="mcp-server-form"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">
              <span className="block text-muted-foreground">
                {t("form.name")}
              </span>
              <Input
                value={draft.name}
                maxLength={MCP_SERVER_NAME_MAX_LENGTH}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="text-sm">
              <span className="block text-muted-foreground">
                {t("form.transport")}
              </span>
              <select
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={draft.transport}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    transport: e.target.value as "stdio" | "http",
                  })
                }
                data-testid="mcp-server-transport"
              >
                <option value="stdio">{t("form.transportStdio")}</option>
                <option value="http">{t("form.transportHttp")}</option>
              </select>
            </label>
          </div>

          {draft.transport === "stdio" ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-sm">
                <span className="block text-muted-foreground">
                  {t("form.command")}
                </span>
                <Input
                  value={draft.command}
                  maxLength={MCP_SERVER_COMMAND_MAX_LENGTH}
                  onChange={(e) =>
                    setDraft({ ...draft, command: e.target.value })
                  }
                  data-testid="mcp-server-command"
                />
              </label>
              <label className="text-sm">
                <span className="block text-muted-foreground">
                  {t("form.args")}
                </span>
                <textarea
                  className="min-h-16 w-full rounded-md border border-input bg-transparent p-2 text-sm"
                  value={draft.args}
                  onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                />
              </label>
            </div>
          ) : (
            <label className="text-sm">
              <span className="block text-muted-foreground">{t("form.url")}</span>
              <Input
                value={draft.url}
                maxLength={MCP_SERVER_URL_MAX_LENGTH}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                data-testid="mcp-server-url"
              />
            </label>
          )}

          <label className="text-sm">
            <span className="block text-muted-foreground">
              {t("form.usageHint")}
            </span>
            <Input
              value={draft.usageHint}
              maxLength={MCP_SERVER_USAGE_HINT_MAX_LENGTH}
              onChange={(e) =>
                setDraft({ ...draft, usageHint: e.target.value })
              }
            />
          </label>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">
              <span className="block text-muted-foreground">
                {t("form.agentTypes")}
              </span>
              <textarea
                className="min-h-16 w-full rounded-md border border-input bg-transparent p-2 text-sm"
                // NOT COPY: these are the stored agent-type identifiers, and
                // the tool names below are the servers' own. Both are matched
                // literally against data, so they stay out of the catalogue.
                placeholder={t("form.agentTypesPlaceholder")}
                value={draft.agentTypes}
                onChange={(e) =>
                  setDraft({ ...draft, agentTypes: e.target.value })
                }
                data-testid="mcp-server-agent-types"
              />
            </label>
            <label className="text-sm">
              <span className="block text-muted-foreground">
                {t("form.toolAllowlist")}
              </span>
              <textarea
                className="min-h-16 w-full rounded-md border border-input bg-transparent p-2 text-sm"
                placeholder={t("form.toolAllowlistPlaceholder")}
                value={draft.toolAllowlist}
                onChange={(e) =>
                  setDraft({ ...draft, toolAllowlist: e.target.value })
                }
                data-testid="mcp-server-tool-allowlist"
              />
            </label>
          </div>

          <label className="text-sm">
            <span className="block text-muted-foreground">
              {draft.transport === "http"
                ? t("form.secretsHeaders")
                : t("form.secretsEnv")}{" "}
              {t("form.secretsNote")}
            </span>
            <textarea
              className="min-h-16 w-full rounded-md border border-input bg-transparent p-2 text-sm"
              // A password-class field: never pre-filled with what is stored,
              // because the API does not hand secrets back.
              placeholder={draft.id ? t("form.secretsPlaceholder") : ""}
              value={draft.secrets}
              onChange={(e) => setDraft({ ...draft, secrets: e.target.value })}
              data-testid="mcp-server-secrets"
            />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                setDraft({ ...draft, enabled: e.target.checked })
              }
            />
            {t("form.enabled")}
          </label>

          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={handleSave}>
              {draft.id ? t("form.save") : t("form.create")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              {t("form.cancel")}
            </Button>
          </div>
        </div>
      )}

      {message && (
        <p className="text-xs text-muted-foreground" data-testid="mcp-servers-message">
          {message}
        </p>
      )}
    </section>
  );
}
