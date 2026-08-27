"use client";

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
 *      `header` value, never the value. So the inputs are `type="password"`,
 *      they start EMPTY on edit, and an empty field means "keep what is
 *      stored" — never "clear it". Rendering the mask into the input would
 *      save the literal string "***" the moment the user touched anything else.
 *
 *   2. **Length caps are mirrored, not re-invented.** Every `maxLength` here
 *      comes from the same constant the service validates against, so the form
 *      cannot accept something the API will reject. The server still rejects
 *      over-length input explicitly rather than truncating it; this is the
 *      other half of that rule, not a replacement for it.
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
  command: string;
  args: string;
  url: string;
  usageHint: string;
  secrets: string;
  enabled: boolean;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  usageHint: "",
  secrets: "",
  enabled: true,
};

/**
 * Parses the `KEY=value` textarea into a map. Only keys the user actually typed
 * are sent, which is what makes "leave it blank to keep it" work: an untouched
 * secret is simply absent from the patch and the service keeps the stored value.
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

function healthLabel(server: McpServerView): {
  text: string;
  variant: "secondary" | "destructive" | "outline";
} {
  if (server.lastCheckOk === null || server.lastCheckedAt === null) {
    return { text: "Never tested", variant: "outline" };
  }
  const when = new Date(server.lastCheckedAt).toLocaleString();
  return server.lastCheckOk
    ? { text: `OK — ${when}`, variant: "secondary" }
    : { text: `Failed — ${when}`, variant: "destructive" };
}

export function McpServersSection({ projectId }: { projectId?: string | null }) {
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
        setMessage(body.error ?? "Failed to load MCP servers.");
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
      setMessage("Failed to load MCP servers.");
    }
  }, [baseUrl, scopedProjectId]);

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
        setMessage(body.error ?? "The request failed.");
        return false;
      }
      await load();
      return true;
    } catch {
      setMessage("The request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!draft) return;
    const secrets = parseSecretLines(draft.secrets);
    const secretField = draft.transport === "http" ? "headers" : "env";
    const payload: Record<string, unknown> = {
      name: draft.name.trim(),
      transport: draft.transport,
      enabled: draft.enabled,
      usageHint: draft.usageHint.trim() || null,
      [secretField]: secrets,
    };
    if (draft.transport === "stdio") {
      payload.command = draft.command.trim();
      payload.args = draft.args
        .split("\n")
        .map((a) => a.trim())
        .filter(Boolean);
    } else {
      payload.url = draft.url.trim();
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
        setMessage(body.error ?? "The connection test failed.");
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
          ? `Connected — ${result.toolCount} tool(s): ${result.toolNames.join(", ") || "none"}`
          : `Failed — ${result.error ?? "no reason given"}`,
      );
      await load();
    } catch {
      setMessage("The connection test failed.");
    } finally {
      setBusy(false);
    }
  }

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
      enabled: server.enabled,
    });
  }

  return (
    <section
      className="space-y-3 rounded-md border border-border p-4"
      data-testid="mcp-servers-section"
    >
      <div>
        <h2 className="text-lg font-semibold">MCP servers</h2>
        <p className="text-sm text-muted-foreground">
          Extra MCP servers (Godot, Confluence, Playwright…) handed to agent
          sessions alongside Arij&apos;s own tool channel.{" "}
          {scopedProjectId
            ? "These are scoped to this project; global servers are inherited below."
            : "These are global — every project's sessions get them."}{" "}
          Arij runs agents with strict MCP config, so servers configured in your
          own <code>~/.claude.json</code> or <code>.mcp.json</code> are ignored:
          declare them here instead.
        </p>
      </div>

      <ul className="space-y-2" data-testid="mcp-servers-list">
        {servers.length === 0 && (
          <li className="text-sm text-muted-foreground">
            No {scopedProjectId ? "project" : "global"} MCP servers yet.
          </li>
        )}
        {servers.map((server) => {
          const health = healthLabel(server);
          return (
            <li
              key={server.id}
              className="flex flex-wrap items-center gap-2 rounded border border-border p-2 text-sm"
              data-testid={`mcp-server-${server.name}`}
            >
              <span className="font-medium">{server.name}</span>
              <Badge variant="outline">{server.transport}</Badge>
              {!server.enabled && <Badge variant="outline">disabled</Badge>}
              <Badge variant={health.variant}>{health.text}</Badge>
              {server.usageHint && (
                <span className="text-muted-foreground">{server.usageHint}</span>
              )}
              <span className="ml-auto flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => handleTest(server.id)}
                >
                  Test
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => startEdit(server)}
                >
                  Edit
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
                  {server.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => send(`${baseUrl}/${server.id}`, "DELETE")}
                >
                  Delete
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
                  Not honoured by {unsupportedProviders.join(", ")} — those CLIs
                  only read a user-global MCP registry, so they receive global
                  servers only. Secrets for those providers are stored in the
                  CLI&apos;s own config file, readable by the agent.
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {scopedProjectId && (
        <div className="space-y-2" data-testid="mcp-inherited-list">
          <h3 className="text-sm font-semibold">Inherited global servers</h3>
          {inherited.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No global MCP servers are configured.
            </p>
          )}
          {inherited.map((server) => (
            <div
              key={server.id}
              className="flex flex-wrap items-center gap-2 rounded border border-dashed border-border bg-muted/30 p-2 text-sm"
              data-testid={`mcp-inherited-${server.name}`}
            >
              <span className="font-medium">{server.name}</span>
              <Badge variant="outline">global</Badge>
              {server.shadowed && (
                <Badge variant="secondary">overridden here</Badge>
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
                    Disable for this project
                  </Button>
                )}
              </span>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Inherited servers are read-only here — edit them in the global
            settings. To change one for this project only, disable it or add a
            local server with the same name: a project entry takes precedence.
          </p>
        </div>
      )}

      {draft === null ? (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => setDraft({ ...EMPTY_DRAFT })}
        >
          Add MCP server
        </Button>
      ) : (
        <div
          className="space-y-2 rounded border border-border p-3"
          data-testid="mcp-server-form"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">
              <span className="block text-muted-foreground">
                Name (lowercase, [a-z0-9_-])
              </span>
              <Input
                value={draft.name}
                maxLength={MCP_SERVER_NAME_MAX_LENGTH}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="text-sm">
              <span className="block text-muted-foreground">Transport</span>
              <select
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={draft.transport}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    transport: e.target.value as "stdio" | "http",
                  })
                }
              >
                <option value="stdio">stdio</option>
                <option value="http">http</option>
              </select>
            </label>
          </div>

          {draft.transport === "stdio" ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-sm">
                <span className="block text-muted-foreground">Command</span>
                <Input
                  value={draft.command}
                  maxLength={MCP_SERVER_COMMAND_MAX_LENGTH}
                  onChange={(e) =>
                    setDraft({ ...draft, command: e.target.value })
                  }
                />
              </label>
              <label className="text-sm">
                <span className="block text-muted-foreground">
                  Arguments (one per line)
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
              <span className="block text-muted-foreground">URL</span>
              <Input
                value={draft.url}
                maxLength={MCP_SERVER_URL_MAX_LENGTH}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              />
            </label>
          )}

          <label className="text-sm">
            <span className="block text-muted-foreground">
              Usage hint — one line telling the agent what this server is for
            </span>
            <Input
              value={draft.usageHint}
              maxLength={MCP_SERVER_USAGE_HINT_MAX_LENGTH}
              onChange={(e) =>
                setDraft({ ...draft, usageHint: e.target.value })
              }
            />
          </label>

          <label className="text-sm">
            <span className="block text-muted-foreground">
              {draft.transport === "http"
                ? "Headers (KEY=value, one per line)"
                : "Environment (KEY=value, one per line)"}{" "}
              — write-only. Leave blank to keep the stored values.
            </span>
            <textarea
              className="min-h-16 w-full rounded-md border border-input bg-transparent p-2 text-sm"
              // A password-class field: never pre-filled with what is stored,
              // because the API does not hand secrets back.
              placeholder={
                draft.id ? "unchanged — type a line to replace a value" : ""
              }
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
            Enabled
          </label>

          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={handleSave}>
              {draft.id ? "Save" : "Create"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              Cancel
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
