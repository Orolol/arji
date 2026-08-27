# Named agents: per-CLI options and persona pre-prompt

A named agent is a name plus a CLI, with an optional model override. This
document covers the two things that sit alongside the model: the per-CLI
**options** each provider declares, and the free-text **persona** injected at
the head of every prompt the agent receives.

Source of truth: `lib/providers/options-registry.ts`. Nothing else declares an
option — the editor renders from it and the providers translate from it.

## 1. The registry

Each provider declares a list of options. An option carries:

| Field | Meaning |
|---|---|
| `key` | stable storage key, persisted per agent — never renamed |
| `label` / `hint` | what the editor shows |
| `type` | `select` \| `bool` \| `number` \| `text` |
| `default` | the "leave it to the CLI" value; a stored value equal to it emits no argument |
| `choices` / `min`,`max` / `pattern` | the accepted values for that type |
| `toArgs(value)` | translation to CLI arguments |
| `resumeSupported` | `false` when the CLI's resume path rejects the flag |

A provider **absent from the registry has no options**: the editor renders no
section and the spawn argv is unchanged. That is the no-regression path for
any CLI added later and not yet measured.

`toArgs` is absent for one option only — claude's permission mode, which
*replaces* a flag Arij already derives rather than appending one. See §3.

## 2. What each CLI exposes, and why

Measured against the CLIs installed on a development machine, not copied from
a plan. Re-probe after a CLI upgrade: vendor flags change semantics between
versions.

### Claude Code (claude 2.1.245)

| Option | Argument |
|---|---|
| `effort` — low / medium / high / xhigh / max | `--effort <v>` |
| `permission_mode` — acceptEdits / auto / bypassPermissions / manual / dontAsk | replaces the derived `--permission-mode`, code-producing sessions only |

`--max-turns` and a `--fast` flag were both provisional in the epic; **neither
exists** in `claude --help` on 2.1.245. Fast mode is a `/fast` slash command
inside an interactive session, not a print-mode flag. `--effort` is the
thinking knob.

### Codex (codex-cli 0.148.0)

| Option | Argument |
|---|---|
| `reasoning_effort` — low / medium / high / xhigh | `-c model_reasoning_effort=<v>` |
| `profile` — identifier | `-p <v>`, **not on resume** |

Codex has no reasoning-effort flag; the documented path is a `-c` config
override, accepted by both `codex exec` and `codex exec resume` (verified with
`--strict-config`, which rejects unknown config fields). `minimal` parses in
the CLI but the API rejects it for gpt-5.5, so it is not offered.

`codex exec resume` takes a strict subset of `codex exec`'s flags — no `-C`,
`-o`, `--color` and no `-p/--profile` — and an unknown flag there is a fatal
argv error. The registry marks `profile` as `resumeSupported: false`.

**Not exposed:** `-s/--sandbox` and the approval policy. The sandbox is what
severs codex's MCP tool channel (see `codexApprovalArgs()` in
`lib/providers/codex.ts`): under any sandbox mode every tool call is refused,
which is how review sessions silently fell back to prose for the whole life of
the database. An option that reintroduces that is a regression with a settings
toggle in front of it.

### Oh My Pi (omp 18.0.5)

| Option | Argument |
|---|---|
| `thinking` — off / minimal / low / medium / high / xhigh / max / auto | `--thinking <v>` |
| `max_time` — seconds, 30..86400 | `--max-time <n>` |
| `advisor` — boolean | `--advisor` |

**Not exposed:** `--approval-mode`. `always-ask` gates device writes behind an
approval that auto-blocks in print mode, which severs the MCP channel — see
the measurement notes in `lib/providers/oh-my-pi.ts`.

Pi itself is not a selectable provider: it has no MCP support at all, and
every Arij provider must carry the per-spawn tool channel (see
`lib/providers/types.ts`). `PiProvider` survives only as omp's base class, and
it reads the registry through `this.type`, so option translation follows
whichever subclass is spawning.

### Antigravity (agy 1.1.22)

| Option | Argument |
|---|---|
| `effort` — low / medium / high | `--effort <v>` |

**Not exposed:** `--mode` — Arij derives the read-only posture from the
session mode, and a per-agent override would contradict it.

**Not exposed:** `--sandbox`, and this one is withheld for a measurement that
could not be *completed* rather than one that came back negative. Two things
would have to hold first: that `run_command` still works (a build agent that
cannot run the test suite is not a tightened build, it is a broken one), and
that the Arij stdio MCP shim still starts — agy spawns it as a child that
inherits `ARIJ_BASE_URL` / `ARIJ_MCP_TOKEN` from the CLI's own environment,
which is exactly what a terminal sandbox restricts. A shell probe on 1.1.22
was inconclusive (the control run without the flag did not write its file
either), and the MCP half cannot be settled without a live token. Worth
re-attempting against a running orchestrator.

## 3. The permission-mode exception

Arij derives claude's `--permission-mode` from the session mode: `plan` for
read-only research, `default` for chat, `bypassPermissions` for code and
analyze. An agent-level `permission_mode` narrows that, under two gates.

**The agent-type gate is the one that matters.** Reviews, grading and the
second-opinion gate all spawn in **mode `code`** — deliberately, because plan
mode refuses the mutating MCP tools they exist to call (`submit_findings`,
`submit_grading`). Anything scoped on the spawn *mode* therefore reaches
reviewers as readily as builds. So the option is scoped on the session's
agent **type** instead: `filterProviderOptionsForAgentType` drops it at the
spawn wiring point for every type that is not code-producing (build,
ticket_build, team_build).

**The spawn-mode gate stays as defence in depth**, for the direct call sites
that never reach the wiring point — CLI chat turns carry `cliOptions` on
`ResolvedAgent` — so a read-only posture (`plan`, `chat`, `analyze`) can
never be handed away by configuration.

**`plan` is not offered as a value at all.** Measured on claude 2.1.245 with
`claude --print --permission-mode <mode> --allowedTools Write`, asked to
write one file:

| Mode | File written |
|---|---|
| `bypassPermissions` | yes |
| `acceptEdits` | yes |
| `manual` | yes |
| `dontAsk` | yes |
| `auto` | yes |
| `plan` | **no** |

`plan` is also the mode that refuses mutating tools regardless of the
allowlist, MCP tools included. An agent set to it could never call
`update_ticket_status`, so its ticket would never leave `in_progress` — and a
reviewer set to it filed no findings and persisted no `review_verdict`,
silently degrading every review to the prose fallback. Arij still derives
`plan` itself for genuinely read-only spawns; what is removed is the ability
to *choose* it per agent. A value stored before that narrowing falls back to
the derived posture rather than reaching argv.

## 4. Persistence

Migration `0041_named_agent_options` adds three columns:

- `named_agents.options` — JSON object, `NOT NULL DEFAULT '{}'`. Holds only
  **non-default** values, so `{}` and "nothing configured" are the same state
  and produce the same argv. Free-form JSON on purpose: adding an option to
  the registry must not require a migration.
- `named_agents.persona_prompt` — nullable text, **no default**. Existing
  agents come out of the migration at NULL, which injects nothing: the persona
  rides at the head of every prompt, so backfilling would silently rewrite the
  prompt of every agent already configured. New agents get the product default
  (`DEFAULT_PERSONA_PROMPT`) at creation time. A persona longer than
  `PERSONA_PROMPT_MAX_CHARS` is **rejected**, not truncated — truncating is a
  silent alteration of a user-supplied value, and the editor (which holds the
  text in local state and never remounts) would go on showing text the
  database no longer has.
- `agent_sessions.cli_options` — JSON object of the options actually in effect
  for one run. The agent can be edited or deleted afterwards, so the session
  row carries its own copy; the session detail reads it from there.

Validation is server-side (`normalizeProviderOptions`) as well as in the
editor. Two paths, deliberately different:

- values the **caller just sent** are rejected with an explicit message;
- values **already stored** that a newly chosen CLI cannot express are reset
  silently. Switching CLI is an ordinary edit and must not leave an agent
  unsaveable behind a bag the editor no longer shows.

Keys the provider does not declare are dropped rather than rejected, in both
paths.

## 5. Where it is wired

`processManager.start()` is the single wiring point — every dispatch path
(manual routes, pipeline stages, night runs, Full Auto, grading, merge
resolution, second opinion) funnels through it, which is why the automated
modes inherit options and persona without a plumbing of their own. It:

1. reads `named_agent_id` and `agent_type` off the session row (one read,
   shared with the MCP block);
2. resolves that agent's options **against the provider this session is
   actually spawning on** (a mismatch degrades to no options rather than
   handing another CLI's flags to a child that would reject them fatally —
   this is what makes review-provider segregation apply the *reviewer's*
   options, not the builder's);
3. drops the options this agent type may not carry
   (`filterProviderOptionsForAgentType`), prepends the persona section **if
   the agent type accepts one**, and attaches `cliOptions` to the spawn;
4. persists the options and the persona-bearing prompt back onto the session
   row.

It works on a **copy** of the caller's options object: the retry ladder
re-dispatches a stage, and a mutated caller object would stack one persona
block per attempt.

Reading the configuration is best-effort, like MCP injection: a session never
fails to spawn because its optional configuration could not be read.

### Which sessions get a persona

`PERSONA_AGENT_TYPES` (lib/agent-config/constants.ts) is an **allowlist**:
the code-producing types, the four review types, the second-opinion gate,
grading and merge. Everything else gets nothing.

The asymmetry is the point. Missing a type in an allowlist costs a persona
that should have applied; missing one in a blocklist writes free-form persona
text into a document Arij persists verbatim — `spec_generation` replaces
`projects.spec`, the memory writers replace the memory document,
`release_notes` becomes `CHANGELOG.md`, and `title_generation` /
`import_analysis` answer under strict format contracts. A persona like
*"answer in French and finish with a bullet summary of your reasoning"* would
land inside the stored artifact and then feed every later prompt. A new agent
type therefore gets no persona until someone adds it on purpose.

This is the same reasoning as `MCP_EXEMPT_AGENT_TYPES`, but the two lists are
not interchangeable: that one is a blocklist about a trailing tools section
and does not include `spec_generation`.

### CLI chat turns

A chat turn has no `agent_sessions` row, so it deliberately bypasses
`processManager.start()` — the same reason `lib/chat/cli-tool-channel.ts`
exists as a separate wiring for the MCP channel. Options ride the resolved
agent instead: `ResolvedAgent.cliOptions` is populated wherever a named-agent
row becomes a resolution, and the chat routes pass it to every spawn (fresh
stream, resume, expired-session retry, dynamic provider).

Chat turns get **options but not the persona**. Structured conversations
(brainstorm, epic creation) are prompt contracts — epic finalization must
answer in strict JSON — and a free-text preamble is exactly the kind of thing
that corrupts them. The persona stays on the agent-session path, which is the
scope the epic gave it: build and review prompts.

## 6. Prompt injection order

```
## Persona                 <- named agent's persona_prompt
# System Instructions      <- role prompt (project scope wins over global)
# Project: <name>
## Project Specification
Project memory
Reference documents
## Epic to Implement / ticket
## Instructions            <- the task
## Arij tools              <- appended by the MCP channel
```

The persona is first, ahead of the role prompt, the specification and the
ticket. The epic listed this as "persona → spec → global prompt → project
prompt → task"; the relative order of the spec and the role prompt is
pre-existing behaviour that was not churned, and "global prompt" and "project
prompt" are not two sections — `resolveAgentPrompt` returns exactly one, with
the project scope overriding the global one.

An empty or whitespace-only persona injects nothing, and the prompt is
byte-identical to what it was before this feature.

The persona is **not** fenced as untrusted, unlike the spec, the memory or a
ticket body. It is configuration the operator typed into the agent editor and
its whole purpose is to instruct the agent. It is not a secret either: it
appears verbatim in the stored prompt and in the session detail.
