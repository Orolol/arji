# Codex app-server persistent chat spike

Date: 2026-08-27

Locally probed version: `codex-cli 0.148.0`

## Decision

**No-go for a production Codex persistent-chat adapter for now.** The protocol is technically capable of supporting warm conversations, but the command, binding generator, and optional protocol surface are still explicitly marked experimental. Arij should keep the existing one-shot `codex exec` chat path until the compatibility and MCP-isolation conditions below are met.

This decision is about adopting the adapter, not feasibility. No Codex adapter is implemented by this spike.

## What was measured

The following local, non-inference probes were run against the installed binary:

```text
codex --version
codex app-server --help
codex app-server daemon --help
codex app-server proxy --help
codex app-server generate-ts --out <temporary-directory>
codex app-server generate-ts --experimental --out <temporary-directory>
codex app-server generate-json-schema --out <temporary-directory>
```

`codex app-server --stdio` accepted newline-delimited JSON-RPC requests. An `initialize` request returned the app-server identity and platform information. A subsequent `thread/start` request with `approvalPolicy: "never"`, `sandbox: "read-only"`, and `ephemeral: true` returned a thread immediately without starting an inference turn.

The installed CLI exposes three transports:

- direct `stdio://` (the default);
- a managed local daemon with a Unix control socket and a `proxy` command that forwards stdio bytes to that socket;
- WebSocket listeners.

The daemon was not started by the spike. `codex app-server daemon version` confirmed that no daemon was already running.

## Feasibility

The generated v2 contract contains the complete minimum lifecycle needed by Arij:

| Arij operation | app-server contract |
| --- | --- |
| Open a conversation | `initialize`, then `thread/start` |
| Restore after a process/server restart | `thread/resume` with the stored `threadId` |
| Send a user turn | `turn/start` with text `UserInput` |
| Stream assistant text | `item/agentMessage/delta` |
| Finish a turn | `turn/completed` |
| Surface failures | `error` and the failed `Turn` payload |
| Cancel a turn | `turn/interrupt` |

`thread/start` and `thread/resume` accept model, working directory, approval, sandbox, developer-instruction, and arbitrary `config` overrides. The returned thread contains a durable id and reports whether direct input is accepted. On the current version, this makes a narrow adapter feasible without polling or parsing terminal output.

For Arij, the safer shape would be one direct stdio app-server process per warm conversation. It matches the existing persistent-runner ownership model and makes process death, idle reaping, and MCP token revocation unambiguous. A shared daemon would save more memory, but it would require additional thread ownership, routing, and failure isolation inside Arij.

## MCP and permissions risk

The non-inference `thread/start` probe emitted MCP startup notifications for servers inherited from the local Codex configuration. The per-thread `config` map makes an Arij MCP override plausible, but the spike did not establish these security properties:

1. that a per-conversation MCP configuration completely replaces inherited servers rather than merging with them;
2. that a short-lived chat token is never serialized into the durable thread rollout used by `thread/resume`;
3. that removing or reaping a thread closes all MCP clients before Arij revokes its token;
4. that a shared daemon cannot expose one conversation's MCP configuration or events to another connection.

An adapter must prove those properties with a fake MCP server and two concurrent conversations before it can be enabled. It must also reassert read-only sandboxing and non-interactive approval behavior on both `thread/start` and `thread/resume`; relying on the user's global Codex configuration is not sufficient.

## Stability assessment

The core v2 methods are present in the generated non-experimental binding set, but their host command is still labelled `[experimental]`. The same 0.148.0 binary generated:

- 655 TypeScript files for the default surface;
- 752 TypeScript files with `--experimental`;
- 51,872 lines across the two bundled JSON Schema documents.

The experimental `ThreadStartParams` already adds numerous fields beyond the default surface. The initialization handshake also asks clients to opt into experimental methods and fields explicitly. These are useful compatibility mechanisms, but not a stability guarantee for the transport, daemon lifecycle, or generated type layout.

Arij should generate fixtures from the installed CLI in tests or CI probes, not commit the whole generated surface. A production adapter should validate only the narrow message union above and tolerate unknown notifications.

## Estimated implementation cost

Estimated cost after the blockers are resolved: **5-9 engineering days**, including:

- JSON-RPC transport, request correlation, and notification demultiplexing: 1-2 days;
- thread start/resume, turn lifecycle, interrupt, and persistent-runner integration: 1-2 days;
- MCP and permission isolation tests: 1-2 days;
- chunk/SSE mapping, UI errors, crash/reaper recovery: 1-2 days;
- version fixtures, upgrade probe, and hardening: 1 day.

A shared-daemon architecture would add lifecycle and multi-conversation routing work and should be estimated separately.

## Conditions to reconsider

Reopen implementation when all of the following hold:

1. the app-server command and the required core methods are documented as supported rather than experimental, or two consecutive supported Codex releases pass an Arij-owned compatibility fixture;
2. per-thread MCP replacement and token non-persistence are documented or mechanically demonstrated;
3. `thread/resume` is verified across an app-server restart with the exact Arij chat configuration;
4. read-only sandbox and approval settings are verified after both start and resume;
5. the adapter has a version probe so every Codex upgrade rechecks the contract before persistent mode is offered.
