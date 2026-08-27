/**
 * Connection test for a user-declared MCP server.
 *
 * Same shape as the OpenAI-compatible mode's "test connection": the user
 * declares a server, presses a button, and finds out immediately whether it
 * answers — instead of discovering a typo in a `command` three builds later
 * through an agent that quietly had no tools.
 *
 * The probe performs a real MCP handshake (`initialize`, then `tools/list`)
 * because those are the two things a session actually needs: a server that
 * starts but exposes nothing is broken in the way that matters. It returns
 * the tool COUNT and NAMES, which is also the input a user needs to decide
 * whether to pin a `tool_allowlist`.
 *
 * ## What this probe must never do
 *
 * - **Block a build.** It is only reachable from the settings UI. Spawn-time
 *   injection never calls it: a third-party server that is down must cost the
 *   session that server, not the session. Health is recorded, not enforced.
 * - **Leak a secret.** `env`/`headers` values go to the child, never into the
 *   returned message or a log line. Transport errors are scrubbed through
 *   `scrubSecrets` before they leave this module, because a stdio server that
 *   fails to start often echoes its own argv or environment.
 * - **Leave a process behind.** Every exit path closes the transport, and the
 *   whole handshake races a timeout. `StdioClientTransport.close()` kills the
 *   child, so an unresponsive server is reaped rather than inherited by the
 *   Next.js process for its lifetime.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerSpec } from "@/lib/providers/types";

/** Upper bound on the whole handshake. */
export const MCP_PROBE_TIMEOUT_MS = 15_000;

/** Cap on how many tool names travel back to the UI. */
export const MCP_PROBE_MAX_TOOL_NAMES = 100;

export interface McpProbeResult {
  ok: boolean;
  /** Number of tools the server exposed (0 when the handshake failed). */
  toolCount: number;
  toolNames: string[];
  /** Human-readable, secret-scrubbed reason. Null on success. */
  error: string | null;
}

/**
 * Removes every configured secret value from a string.
 *
 * Keyed on the VALUES rather than on a pattern: a third-party server's failure
 * output is not something Arij controls, and matching `Bearer\\s+\\S+` would
 * miss a token echoed as part of a URL, a JSON blob, or an argv dump. The
 * values are exactly what must not appear, so they are exactly what is
 * searched for.
 */
export function scrubSecrets(text: string, secrets: string[]): string {
  let scrubbed = text;
  for (const secret of secrets) {
    // A short value would match everywhere; those are not credentials.
    if (!secret || secret.length < 4) continue;
    scrubbed = scrubbed.split(secret).join("<redacted>");
  }
  return scrubbed;
}

function secretValues(spec: McpServerSpec): string[] {
  return [
    ...Object.values(spec.env ?? {}),
    ...Object.values(spec.headers ?? {}),
  ].filter((value) => typeof value === "string" && value.length > 0);
}

/**
 * Runs the handshake against `spec`. Never throws — every failure comes back
 * as `{ ok: false, error }` so the route has one shape to serialize.
 */
export async function probeMcpServer(
  spec: McpServerSpec,
  timeoutMs = MCP_PROBE_TIMEOUT_MS,
): Promise<McpProbeResult> {
  const secrets = secretValues(spec);
  const fail = (message: string): McpProbeResult => ({
    ok: false,
    toolCount: 0,
    toolNames: [],
    error: scrubSecrets(message, secrets),
  });

  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  try {
    if (spec.command !== undefined) {
      transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        // The child gets ONLY what the server declares plus what the SDK
        // considers safe to inherit — not Arij's own environment, which holds
        // the GitHub PAT and every other provider credential.
        env: { ...spec.env },
        // Never let a chatty server write into the Arij server's stderr; the
        // pipe is drained by the transport and dropped.
        stderr: "pipe",
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(spec.url), {
        requestInit: { headers: { ...spec.headers } },
      });
    }
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "could not create the transport",
    );
  }

  const client = new Client(
    { name: "arij-mcp-probe", version: "1.0.0" },
    { capabilities: {} },
  );

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    // `connect` performs the `initialize` exchange.
    await Promise.race([client.connect(transport), timeout]);
    const listed = await Promise.race([client.listTools(), timeout]);

    const names = (listed.tools ?? []).map((tool) => tool.name);
    return {
      ok: true,
      toolCount: names.length,
      toolNames: names.slice(0, MCP_PROBE_MAX_TOOL_NAMES),
      error: null,
    };
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "the server did not respond",
    );
  } finally {
    if (timer) clearTimeout(timer);
    // Both paths, always: close() kills a stdio child, so a server that hung
    // during the handshake does not outlive the request that started it.
    try {
      await client.close();
    } catch {
      // already gone
    }
    try {
      await transport.close();
    } catch {
      // already gone
    }
  }
}
