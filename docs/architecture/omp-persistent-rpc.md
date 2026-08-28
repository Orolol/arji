# Oh My Pi persistent chat RPC probe

This note records the protocol Arij's persistent chat adapter depends on. Re-run the probe after every Oh My Pi upgrade; RPC is an embedding boundary, so undocumented event-shape drift must fail visibly rather than silently truncate a chat response.

## Probe history

| Date | Binary | Result |
| --- | --- | --- |
| 2026-08-25 | `omp` 17.2.1 | Startup emitted `ready` with protocol 1, supported protocols 1/2, a 1 MiB frame limit, and a 64 MiB reassembled-frame limit. Startup then emitted UI/command events. |
| 2026-08-27 | `omp` 18.0.5 | Re-probed locally. The same `ready` contract and limits are present. Strict LF-delimited JSONL commands, `prompt` input and streaming `message_update` events all confirmed. **The end-of-run signal recorded on this row was wrong**: `agent_settled` was never emitted, and the string does not exist anywhere in the 18.0.5 binary. |
| 2026-08-27 | `omp` 18.0.5 | Corrective probe. A real two-turn RPC conversation ended each turn with `turn_end` then `agent_end` carrying `isTerminal: true`; no `agent_settled` frame arrived in either turn. `omp read omp://docs/rpc.md` states the rule directly: "agent turns complete only on `agent_end` frames where `isTerminal !== false`". `grep -a -c agent_settled $(which omp)` returns 0. Also corrected: the compaction event is `auto_compaction_end`, not `compaction_end`. |

Non-billing startup probe:

```sh
omp --version
timeout 3s omp --mode rpc --no-tools --no-title
```

The observed first frame on 18.0.5 was:

```json
{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}
```

No user prompt was sent by this probe, so it made no model request.

## Adapter mapping

| Direction | OMP RPC frame | Arij behavior |
| --- | --- | --- |
| Startup | `ready` | Require protocol 1, store `maxFrameBytes`, and release the runner's readiness wait. |
| Arij → OMP | `{"id":"…","type":"get_state"}` | Discover the provider-owned session ID for durable `--resume`. |
| Arij → OMP | `{"id":"…","type":"prompt","message":"…"}` | Send one user turn. Reject locally when the encoded JSONL frame exceeds the negotiated limit. |
| OMP → Arij | `response` / `prompt` | Treat `success:false` as a visible turn failure. A successful response only acknowledges acceptance. |
| OMP → Arij | `message_update.assistantMessageEvent.text_delta` | Emit an existing chat SSE `delta`. |
| OMP → Arij | `message_update.assistantMessageEvent.thinking_start` | Emit an existing chat SSE status. Thinking text itself is not displayed. |
| OMP → Arij | `tool_execution_start` | Emit an existing chat SSE tool status. |
| OMP → Arij | `message_end` | Keep the authoritative assistant text as a fallback and inspect `stopReason` / `errorMessage`. Ignore `role: "user"` echoes. |
| OMP → Arij | `agent_end` with `isTerminal !== false` | **The end of a turn.** A frame carrying `isTerminal: false` (or `willContinue: true`) means maintenance or async delivery scheduled more work and the session will resume, so it must not close the turn. |
| OMP → Arij | `response`/`prompt` with `data.agentInvoked: false`, or a later `prompt_result` with `agentInvoked: false` | The prompt was resolved locally without an agent turn (a slash command). No agent lifecycle events follow, so this is the only completion signal for that path. |
| OMP → Arij | `turn_end`, `agent_start`, `turn_start`, `message_start` | Lifecycle only. `turn_end` precedes `agent_end` and is **not** terminal — a run can contain several turns. |
| OMP → Arij | `auto_compaction_end` | Ignored. Its `errorMessage` is not terminal: the runtime immediately falls through to the next compaction method. A genuinely failed run still reaches `message_end`/`auto_retry_end` and then `agent_end`. |
| OMP → Arij | `extension_ui_request`, `available_commands_update`, other extension events | Ignore for V1. Interactive permission/UI requests remain out of scope. |

The process is launched with `--mode rpc` and the existing read-only OMP tool allowlist. It passes **no** `--config` overlay: the `tools.xdev: false` overlay it used to carry is a measured no-op on omp 18.0.6, and `--config` is a lever over the user's whole `~/.omp/agent/config.yml` — see `docs/architecture/mcp-provider-matrix.md`. Its per-conversation MCP token uses OMP's environment expansion and is revoked only when the warm process exits.

If the terminal frame never arrives at all — a wedged CLI, or a future event rename like the one above — the runner's provider-agnostic silent-turn watchdog fails the turn with a visible error and drops the process, so its warm slot and MCP token return to the pool. It is armed when a turn starts and re-armed on every frame, so a slow-but-streaming turn is never cut off. Default 5 minutes, overridable with the `chat_persistent_turn_stall_ms` setting.

## Upgrade checklist

1. Record `omp --version` and re-run the startup probe.
2. Confirm protocol 1 remains in `supportedProtocolVersions` and record both frame limits.
3. Check the installed reference (`omp read omp://docs/rpc.md`) for `prompt`, `message_update`, `message_end`, `agent_end` / `isTerminal`, `prompt_result` / `agentInvoked`, and `get_state`.
4. Confirm the terminal-event rule has not moved: send one real prompt over `--mode rpc` and check that the turn ends on `agent_end` with `isTerminal !== false`. Event *names* must be verified against the binary, not assumed — `grep -a -c '<event>' $(which omp)` is the cheap check, and it is what would have caught `agent_settled` and `compaction_end`, two events this adapter once keyed off that have never existed.
5. Run `npx vitest run __tests__/persistent-chat-runner.test.ts`.
6. Manually send two turns in one Oh My Pi persistent conversation; confirm the reply arrives, the spinner stops, the warm badge remains visible, and only one `omp --mode rpc` process exists.
