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
 *   fails to start often echoes its own argv or environment — and the failing
 *   server's stderr, which this module deliberately surfaces (below), is
 *   exactly where that happens. The scrub is load-bearing, not decorative.
 * - **Swallow the reason.** A server that starts, rejects its own config and
 *   exits reports `MCP error -32000: Connection closed` at the protocol level
 *   — which tells the user nothing, and is the commonest real failure. The
 *   actual diagnostic is on the child's stderr, so a failed handshake reads it
 *   back and appends it. "A readable error" is the story's criterion.
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

/**
 * Cap on how much of a failing server's own diagnostic is appended to the
 * error. Enough for a config error or the head of a stack trace, far short of
 * letting a chatty server write a log file into a database column.
 */
export const MCP_PROBE_STDERR_MAX_CHARS = 600;

/**
 * How long a failed handshake waits for the child's buffered stderr.
 *
 * The child is normally dead by this point, so the stream ends at once. The
 * bound is for the timeout path, where it is still running and no `end` is
 * coming.
 */
const STDERR_DRAIN_MS = 250;

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
 * Collects what a stdio server prints on its way down.
 *
 * Two jobs, and the second is why this attaches UP FRONT rather than reading
 * the pipe once the handshake has already failed:
 *
 *  1. **Readability.** A server that starts, rejects its own configuration and
 *     exits is only `MCP error -32000: Connection closed` at the protocol
 *     level. The reason it printed is on stderr, and nothing else recovers it.
 *  2. **Not stalling the child.** `stderr: "pipe"` with no reader stops the
 *     server dead once the OS buffer fills (~64 KiB), so a chatty one would
 *     hang until the probe's own timeout instead of failing in milliseconds.
 *     That is why `onData` keeps consuming after the cap and only stops
 *     *storing* — draining is the point, the text is the by-product.
 *
 * The SDK spawns the child inside `connect()`, so the stream does not exist
 * when this is called; it is polled for a few ticks instead. Bounded on size
 * (the text reaches an error message and a database column) and on time (on
 * the timeout path the child is alive and no `end` event is coming).
 */
function collectStderr(transport: StdioClientTransport) {
  let text = "";
  let stream: NodeJS.EventEmitter | null = null;
  let markEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    markEnded = resolve;
  });

  const onData = (chunk: Buffer | string) => {
    if (text.length < MCP_PROBE_STDERR_MAX_CHARS) text += chunk.toString();
  };

  const attach = () => {
    const candidate = transport.stderr;
    if (!candidate || stream) return;
    stream = candidate;
    clearInterval(poll);
    candidate.on("data", onData);
    candidate.once("end", markEnded);
    candidate.once("error", markEnded);
  };
  const poll = setInterval(attach, 10);
  attach();

  return {
    /** The diagnostic, once the child's stderr ends or the bound elapses. */
    async settle(): Promise<string> {
      let timer: NodeJS.Timeout | undefined;
      const bound = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STDERR_DRAIN_MS);
      });
      try {
        await Promise.race([ended, bound]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      // Keep the HEAD: for a config error that is the whole message, and for a
      // stack trace it is the line that names the cause.
      return text.slice(0, MCP_PROBE_STDERR_MAX_CHARS).trim();
    },
    stop() {
      clearInterval(poll);
      stream?.off("data", onData);
    },
  };
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
        // Piped rather than inherited, so a chatty server never writes into
        // the Arij server's own stderr. `collectStderr` below reads the pipe
        // for the duration: that is where a failing server's real diagnostic
        // comes from, and leaving it unread would stall the child once the
        // buffer filled.
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

  // Attached before the handshake: see collectStderr — reading the pipe only
  // on failure is too late to stop a chatty server from blocking on it.
  const stderrs =
    transport instanceof StdioClientTransport ? collectStderr(transport) : null;

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
    const reason =
      error instanceof Error ? error.message : "the server did not respond";
    // Settled BEFORE the `finally` closes the transport and kills the child.
    const diagnostic = stderrs ? await stderrs.settle() : "";
    return fail(
      diagnostic ? `${reason} — the server reported: ${diagnostic}` : reason,
    );
  } finally {
    if (timer) clearTimeout(timer);
    stderrs?.stop();
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
