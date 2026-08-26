# MCP tool channel — provider matrix

Which CLI providers can actually reach Arij's `mcp__arij__*` tools, how the
config is handed to each, and what was measured rather than assumed.

Audited 2026-08-20 after epic E-arij-096, where `review_comments` turned out to
have been empty for the entire life of the database — every review had silently
fallen back to prose, and every builder was dispatched without a single
finding. See `lib/pipeline/parse-review-report.ts` for the recovery path.

## The gate

`providerSupportsMcp()` in `lib/claude/mcp-injection.ts` decides who gets a
channel. The constraint it encodes is the token: Arij mints a bearer per
session and revokes it when the process exits (`lib/mcp/token-store.ts` — the
store is in-memory, and there is no long-lived token to fall back on).

That is usually satisfied by handing the CLI its config **per spawn**, which is
what claude-code and codex do. But a config *file* can qualify too, as long as
the host expands environment variables at load time: the file references
`${ARIJ_MCP_TOKEN}` and the spawn supplies the value. omp works that way, so
"config-file only" is not by itself a disqualification — "no variable
expansion" is.

## Matrix

| Provider | Binary | Installed | Sessions to date | Channel | How config is passed |
|---|---|---|---|---|---|
| claude-code | `claude` 2.1.221 | yes | 94 | **yes** | `--mcp-config <file>` + `--strict-mcp-config`, tools named in `--allowedTools` |
| codex | `codex` 0.148.0 | yes | 20 | **yes** | `-c mcp_servers.arij.*` TOML overrides + `--dangerously-bypass-approvals-and-sandbox` |
| oh-my-pi | `omp` 17.2.1 | yes | 15 | **yes** | `mcp.json` entry (install.sh) + `ARIJ_*` env vars at spawn; MCP tools orthogonal to `--tools` (see below) |
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

## omp — wired 2026-08-21

`omp` and `pi` are different products with a confusingly similar lineage
(can1357/oh-my-pi vs earendil-works/pi), and Arij's `OhMyPiProvider` extending
`PiProvider` makes it easy to assume they share a capability set. They do not:
**omp has full MCP support**, documented at <https://omp.sh/docs/mcp>. It is
absent from `omp --help` and from `~/.omp/agent/config.yml`, which is what made
an earlier pass of this audit call it unsupported.

Servers come from `mcp.json`, read in priority order:

1. `.omp/mcp.json` — project, omp-managed
2. `~/.omp/agent/mcp.json` — user, omp-managed
3. `.claude/`, `.cursor/`, `.vscode/`, `.gemini/`, `.windsurf/`, `opencode.json` — auto-discovered
4. `mcp.json` / `.mcp.json` at the repo root — lowest priority

stdio and streamable-HTTP transports, standard `mcpServers` schema, and
crucially `${VAR}` / `${VAR:-default}` expansion across `command`, `args`,
`env`, `cwd`, `url`, `headers`, `auth` and `oauth` — evaluated at load time.
That expansion is what makes a per-session bearer token possible without a
per-spawn flag: the entry references `${ARIJ_MCP_TOKEN}` and Arij supplies the
value in the child's environment. `install.sh` writes exactly that entry into
`~/.omp/agent/mcp.json`.

The entry was inert until 2026-08-21; four things changed, mirroring the
audit's checklist:

1. `providerSupportsMcp()` admits `oh-my-pi`.
2. `OhMyPiProvider.buildEnv()` merges `options.mcp.env` — `ARIJ_BASE_URL`,
   `ARIJ_MCP_TOKEN`, and `ARIJ_MCP_TOOLSET` for chat turns — into the child's
   environment; `BaseCliProvider.buildEnv` gained the `options` parameter to
   make that possible. RESIDUAL EXPOSURE, accepted: the token is in the
   child's env, so the agent's bash subshells inherit it — same trust
   boundary as codex's argv exposure, revoked at session end.
3. **Tool names differ**, and both naming surfaces are now per-provider:
   omp surfaces tools as `mcp__<server>_<tool>` — a SINGLE underscore between
   server and tool — so `arijMcpToolName("oh-my-pi", …)` spells
   `mcp__arij_get_ticket` into `allowedToolNames`, and `arijToolsSection`
   takes the provider's prefix for its prompt text. claude/codex spelling
   (and their prompts) stay byte-identical.
4. The audit assumed non-code sessions would need the Arij names added to
   `--tools`. Measured on 17.2.1, the OPPOSITE is true, in both directions:
   MCP tools are orthogonal to that allowlist — under `--tools
   read,grep,glob` they stay mounted (as `xd://mcp__arij_*` devices invoked
   through the `write` built-in) and a fake-token probe's call still reached
   the server — while ADDING an MCP name to `--tools` is a fatal argv error
   (`Unknown tools in --tools: …`, validated against built-in names only)
   that kills the spawn before the session starts. So no flag work at all:
   review sessions keep the channel, and MCP names must never be appended.

The `mcp.json` entry also passes `ARIJ_MCP_TOOLSET` through
(`${ARIJ_MCP_TOOLSET:-agent}`), so a CLI chat turn on omp — which mints a
chat-scoped token — selects the shim's board toolset instead of the agent
five. Re-run `install.sh` (or just its MCP step) on machines that wrote the
entry before the passthrough existed. The stale-entry failure is quiet, not
loud: a chat turn's shim serves the agent five to a chat token, and three of
them (get_ticket, update_ticket_status, post_comment) actually SUCCEED once
the model supplies an explicit ticket_id — only ask_question and
submit_findings 403 on chat tokens — so the symptom is a confusingly
half-working chat with agent-flavored tool descriptions, easy to misread as
model flakiness. The selector is presence-based, so
`OhMyPiProvider.buildEnv` strips any `ARIJ_MCP_TOOLSET` inherited from the
server's own environment when the channel doesn't set one — otherwise a
stray export would silently hand every agent session the board-wide chat
toolset (create_ticket, start_build) on an agent token.

Note also `tools.discoveryMode` in `~/.omp/agent/config.yml`: past 40 tools the
default `auto` mode hides MCP tools behind a `search_tool_bm25` discovery step
rather than putting them in the prompt. Worth pinning if Arij's five tools ever
need to be unconditionally visible.

## pi — no MCP

Pi has no built-in MCP support by design — it is extension-based, and MCP is an
open feature request
([earendil-works/pi#563](https://github.com/earendil-works/pi/issues/563));
third-party distributions prewire it as an extension. Nothing in `pi --help` or
`~/.pi/agent/settings.json` references it.

Sessions on pi work from prose conventions alone. That
is survivable because the review contract does not depend on the channel:
reviewers must still end with `**Overall Verdict: …**`, and
`ingestProseFindings` recovers anchored findings from the report whatever the
provider.

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
