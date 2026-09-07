# Composite chat dispatch — review corrections

Epic E-BwEtdU8xBcbs, story 3: “As a user dispatching a task, I want a composite agent to unfold to one of its members so that the choice works identically from a manual dispatch, a role assignment or a chat conversation”. Baseline: `ef58d4ed`.

## Findings addressed

- **[RC:wusUF-LvgwQl], major:** `chat/stream` now reserves persistent execution for a conversation without a named agent. A selected composite is unfolded on each turn, and the resulting member owns provider, model and CLI options. The conversation's stored provider remains its fallback if the selected agent is deleted. This also uses ordinary named-agent execution when the member and the stored persistent mode share a base provider, preserving the named agent's CLI options. The PATCH persistence behavior is unchanged.
- **[RC:AOxxJkRq60SV], minor:** non-stream `chat` resolves the chosen agent before inserting a user message or associating attachments. An emptied explicit composite returns the existing actionable JSON 400 without leaving a user message behind.

A source sweep found one application caller of `runPersistentChatTurn`, in the stream route; its initial call and expired-session retry share the corrected selection. Both chat POST entry points now resolve before their first message write. No pipeline, schema, picker or provider implementation was changed.

## Regression evidence

`composite-persistent-chat.test.ts` uses the real conversation PATCH and chat stream POST handlers, the real resolver and an isolated SQLite database built from the actual migrations. Only process runners/provider spawning and the CLI tool channel are substituted. It checks:

1. A composite selected through PATCH on Claude Code persistent mode launches its `agy` member with `model-one`.
2. The same selection on Oh My Pi persistent mode also launches that member.
3. Reordering the composite without repatching the conversation launches the new first member, `codex` with `model-two`.
4. A Claude Code member uses ordinary named-agent execution with its configured model and CLI options.
5. Selecting a simple agent retains that agent's execution path.
6. A conversation without a named agent retains persistent execution.

The tests drain the SSE body and assert the runner actually selected; the non-Claude cases also assert the persisted assistant reply. They prove Arij's dispatch boundary, not any real CLI or model behavior. No real AI process or external service was used.

`composite-route-boundaries.test.ts` additionally invokes the real non-stream handler after deleting the composite's final member through the FK cascade and asserts both the JSON 400 and zero stored messages.

Before the production edits, these two suites produced **5 failures / 11 passes** on `ef58d4ed`: four persistent-runner routing cases and the orphan-message case. After the fix, all **16** cases pass. The six targeted chat suites passed **66 tests**. A later CLI-option assertion initially used the wrong fixture column (`cli_options` instead of `named_agents.options`); the first full run therefore had **1 failure / 8,484 passes**. The fixture was corrected and the two regression suites passed again; application code did not change during that correction.

## Final validation

Code commit: `71bbb36d`. Final full `npm test` run: **618 files / 8,485 tests passed**, in 135.45 seconds. All seven new regression cases are included. No failures remained.

- Existing worktree `node_modules` used; lockfile/install consistency: **6 tests passed**. No dependency install or update.
- `npx tsc --noEmit`: passed.
- `npm run lint`: **0 errors / 25 warnings**, none in the correction's files. Targeted lint rechecked after the fixture correction.
- `NODE_ENV=production npm run build`: passed.
- `git diff --check`: passed.
- No browser check rerun: this correction changes server dispatch and refusal ordering only. No new visual or real-provider claim is made.

## Integration and scope

Read-only integration preview of code commit `71bbb36d` against local `main` `3183240e6669575474cd556ceb6cc85cb3780205`: **9 textual conflicts**. Since merge-base `77b00390`, main changed **440 paths**, the committed branch changed **101 paths**, and **13 paths overlap**. Main was not merged and no remote fetch was performed.

Migration numbering was rechecked against that same tip: main ends at `0052_refinement_actions`; branch migrations `0053_composite_agents`, `0054_drop_named_agent_escalation`, and `0055_agent_session_composite_agent` have no collision, with strictly increasing journal timestamps. This is separate from the textual conflicts, and both measurements expire as main advances. Recheck at merge time.

No migration or historical-data backfill was added; the earlier real-development-DB migration validation was not repeated. This correction leaves the stored specification, `CLAUDE.md` and existing documentation unchanged; this QA report is the only prose addition. Main/i18n integration remains separate (B-arij-275).

The new regression database is in memory and closed by the suite. No test server, on-disk scratch database, scratch repository, browser session or probe spec was created. Build/test caches remain ignored.
