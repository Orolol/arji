# Oh My Pi persistent chat RPC probe

This note records the protocol Arij's persistent chat adapter depends on. Re-run the probe after every Oh My Pi upgrade; RPC is an embedding boundary, so undocumented event-shape drift must fail visibly rather than silently truncate a chat response.

## Probe history

| Date | Binary | Result |
| --- | --- | --- |
| 2026-08-25 | `omp` 17.2.1 | Startup emitted `ready` with protocol 1, supported protocols 1/2, a 1 MiB frame limit, and a 64 MiB reassembled-frame limit. Startup then emitted UI/command events. |
| 2026-08-27 | `omp` 18.0.5 | Re-probed locally. The same `ready` contract and limits are present. `docs/rpc.md` in the installed package confirms strict LF-delimited JSONL commands, `prompt` input, streaming `message_update` events, and `agent_settled` as the authoritative end-of-run signal. |

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
| OMP → Arij | `message_end` | Keep the authoritative assistant text as a fallback and inspect `stopReason` / `errorMessage`. |
| OMP → Arij | `agent_settled` | Finish the turn only here, after retries, compaction retries, and queued continuations have settled. |
| OMP → Arij | `extension_ui_request`, `available_commands_update`, other extension events | Ignore for V1. Interactive permission/UI requests remain out of scope. |

The process is launched with `--mode rpc`, the existing read-only OMP tool allowlist, and the existing `tools.xdev: false` overlay. Its per-conversation MCP token uses OMP's environment expansion and is revoked only when the warm process exits.

## Upgrade checklist

1. Record `omp --version` and re-run the startup probe.
2. Confirm protocol 1 remains in `supportedProtocolVersions` and record both frame limits.
3. Check the installed `docs/rpc.md` definitions for `prompt`, `message_update`, `message_end`, `agent_settled`, and `get_state`.
4. Run `npx vitest run __tests__/persistent-chat-runner.test.ts`.
5. Manually send two turns in one Oh My Pi persistent conversation; confirm the warm badge remains visible and only one `omp --mode rpc` process exists.
