# MCP tool channel — provider matrix

Which CLI providers can actually reach Arij's `mcp__arij__*` tools, how the
config is handed to each, and what was measured rather than assumed.

Audited 2026-08-20 after epic E-arij-096, where `review_comments` turned out to
have been empty for the entire life of the database — every review had silently
fallen back to prose, and every builder was dispatched without a single
finding. See `lib/pipeline/parse-review-report.ts` for the recovery path.

## The gate

`providerSupportsMcp()` in `lib/claude/mcp-injection.ts` decides who gets a
channel. A provider qualifies only if it can be handed MCP config **per spawn**:
the bearer token is minted per session and revoked when the process exits, so a
provider that only reads a global config file cannot be given a scoped token.

## Matrix

| Provider | Binary | Installed | Sessions to date | Channel | How config is passed |
|---|---|---|---|---|---|
| claude-code | `claude` 2.1.221 | yes | 94 | **yes** | `--mcp-config <file>` + `--strict-mcp-config`, tools named in `--allowedTools` |
| codex | `codex` 0.148.0 | yes | 20 | **yes** | `-c mcp_servers.arij.*` TOML overrides + `--dangerously-bypass-approvals-and-sandbox` |
| oh-my-pi | `omp` 17.2.1 | yes | 15 | no | no MCP surface (see below) |
| pi | `pi` 0.84.2 | yes | 6 | no | no MCP surface (see below) |
| gemini-cli | `gemini` | no | 0 | no | config-file only, no per-spawn flag |
| deepseek, kimi, zai, qwen-code, opencode, mistral-vibe | various | no | 0 | no | not investigated — none installed, none ever dispatched |

Every provider class extends `BaseCliProvider` directly (except `oh-my-pi`,
which extends `PiProvider`), and each spawns its own binary. None wraps the
`claude` binary, so none inherits `--mcp-config` for free.

## claude-code — works, and it is proven in the data

The only provider with positive evidence of real tool use. `ticket_activity_log`
holds 22 rows whose `reason` is free prose written by the agent itself
("Les 4 user stories sont implémentées et testées (2444 tests verts…)"). Only
`update_ticket_status` called with a custom `reason` produces that; every
server-side route writes a fixed string.

Config rides a 0600 temp file rather than argv, which is what keeps the bearer
token out of `/proc/<pid>/cmdline`.

## codex — works, but only with approvals bypassed

`codex exec` closes stdin. Its approval prompt reads EOF and treats it as a
refusal, and **every MCP tool call is gated on that prompt**. Measured on
0.148.0 with a stdio probe server that appends to a marker file on startup and
on every call it receives:

| Flags | Server starts | Tool call |
|---|---|---|
| `-s read-only` | yes | refused |
| `-s workspace-write` | yes | refused — *"the tool requires approval, but approvals are disabled"* |
| `--dangerously-bypass-approvals-and-sandbox` | yes | **completes** |

The same switch controls approvals and the sandbox; the CLI offers no way to
separate them, and none of the config keys that look like they should help
(`approval_policy`, `tools_require_approval`, `mcp_approval_policy`,
`trusted_mcp_servers`) have any effect — upstream
[openai/codex#24135](https://github.com/openai/codex/issues/24135), open.

So Arij passes the bypass flag for every codex mode. The sandbox was already
costing more than it bought: under `-s read-only` a reviewer cannot create a
temp directory, so vitest and playwright refuse to start and reviews get signed
off without the suite ever running. Containment comes from the disposable
per-ticket worktree, the same thing that has always contained the claude-code
agents running `--permission-mode bypassPermissions`.

Unlike claude's `--mcp-config`, codex's `-c` mechanism has no file form, so the
token rides in argv. Accepted, local-only, and masked everywhere downstream —
see the comment on `buildCodexMcpOverrideArgs`.

> **A caution for whoever audits this next.** The first pass of this audit
> concluded codex could not start MCP servers at all. That was wrong: the probe
> server was sitting outside any `node_modules` and died on
> `ERR_MODULE_NOT_FOUND` before writing its marker. `RUST_LOG=debug` showed
> `mcp_servers="probe, codex_apps"` and a live `stdio_server_launcher` all
> along. Check the server's own stderr before concluding the client is at fault.

## pi and oh-my-pi — no MCP to pass

Neither CLI mentions MCP anywhere in its help output, and neither config
(`~/.pi/agent/settings.json`, `~/.omp/agent/config.yml`) has a server section.
Pi has no built-in MCP support by design — it is extension-based, and MCP is an
open feature request
([earendil-works/pi#563](https://github.com/earendil-works/pi/issues/563));
third-party distributions prewire it as an extension. `oh-my-pi` inherits Pi's
model and adds its own tool system plus an ACP server mode (`omp acp`).

Both are dispatched regularly, so **any session on these providers works from
prose conventions alone**. That is survivable because the review contract does
not depend on the channel: reviewers must still end with `**Overall Verdict: …**`,
and `ingestProseFindings` recovers anchored findings from the report whatever
the provider. Worth revisiting if Pi's MCP extension lands.

## gemini-cli — config-file only

MCP servers are read from `~/.gemini/settings.json` or a project-local
`.gemini/settings.json`. There is no per-spawn flag, and the project form would
mean writing config into user worktrees.

One route exists if this is ever wanted: gemini expands environment variables
inside the `env` block of a server entry, so a *global* settings.json could
reference `$ARIJ_MCP_TOKEN` while `buildEnv()` supplies the per-session value.
That keeps the token scoped without touching worktrees. Untested — the CLI is
not installed here.

## Re-running the probe

The measurements above come from a stdio MCP server exposing one tool, which
appends `SERVER_STARTED` on boot and `CALLED <tool> <args>` per call. Put it
somewhere the MCP SDK resolves (inside this repo, not a scratch directory),
register it, then compare marker contents across flag combinations.
`RUST_LOG=debug codex exec …` prints server registration and the server's own
stderr, which is what distinguishes "never launched" from "launched and
crashed" from "launched and refused".
