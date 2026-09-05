# Arij

**Your AI-powered project manager that actually writes the code.**

Arij is a local-first web app that lets you plan, organize, and build software projects using AI coding agents like Claude Code, OpenAI Codex, Oh My Pi, or Antigravity. Describe what you want, and Arij orchestrates the AI to implement it — managing git branches, worktrees, code reviews, and merges automatically.

Everything runs on your machine. No cloud. No account. No telemetry.

> **On screenshots.** `public/screenshots/` still holds four PNGs
> (`dashboard`, `kanban`, `ticket`, `chat`) captured before the UI was
> rebuilt. They show a product that no longer exists, so this README embeds
> none of them and describes the screens in prose instead. The files are kept
> only as a record; nothing links to them.

---

## Why Arij?

Most AI coding tools work at the file level — you prompt, you get code, you paste it in. Arij works at the **project level**:

- **You describe features as epics**, not individual prompts
- **AI agents build, review, and merge** code in isolated git worktrees
- **The screen is organised by what needs you**, not by workflow state
- **Multiple AI providers** can work in parallel on different tasks
- **Everything is local** — your code never leaves your machine

---

## Features

### The control desk

`/` is a cross-project control desk (`components/desk/`, fed by a single
`GET /api/control-desk` poll). Agents perform the status transitions
themselves, so the desk is not a set of workflow columns you push cards
through — it is five **attention strata**, stacked in a fixed order of
urgency:

| Stratum | Colour | What it holds |
|---------|--------|---------------|
| **WORKING** | turquoise | live agent sessions, plus the queued count and the day's roll-up |
| **YOUR TURN** | coral | everything blocked on a human: agent questions, failed sessions, merge conflicts |
| **READY TO LAND** | sun | branches whose merge would actually succeed — membership is `evaluateMergeReadiness().ready`, the same check Full Auto's merge selector runs |
| **UP NEXT** | pool blue | the order Full Auto will pick from, ranked by `compareExecutionOrder` in `lib/kanban/queue.ts` |
| composer | linden | type a title, `⏎` files the ticket, `⇧⏎` files it *and* dispatches a builder |

Only WORKING grows; the others size to their content, so a stratum with
nothing in it folds down to its label line. A morning with nothing blocked
shows one coral line and no placeholder card.

**Nothing in Arij is reordered by dragging any more** — not on the desk, not in
the registry. (The one remaining drop target in the app is the docs uploader on
the Spec page, which is a plain HTML5 file target.) Order in UP NEXT *is*
execution order — `epics.position` is Full Auto's contract — so re-prioritising
happens deliberately from the ticket overlay or from Refinement, never as a
side effect of a display list being rearranged.

`/projects/:id` renders the same desk pre-filtered to one project, and adds the
project-scoped controls (batch dispatch, night runs, deep links).

### The ticket overlay

Clicking a ticket opens it as a modal over the still-live desk
(`components/ticket/`), replacing the old three-tab side panel. Description,
pipeline, agents, dependencies, user stories, git state and the conversation
are all on one screen; only the full diff swaps the body in place. The desk
keeps polling behind the scrim, so closing the overlay costs no reload.

`Send to Dev` dispatches a build agent from here; `⌘`/`Ctrl`-click on the desk
selects tickets instead of opening them, for batch build / review / merge.

### The global top bar

One bar on every route (`components/piscine/TopBar.tsx`, mounted by
`app/layout.tsx`). It replaced the left project rail, which is gone. Three
zones:

- **left** — the logo pill (always back to the desk) and the project chips; the
  active project wears its colour, and a project with a live agent breathes.
- **center** — a direct `Now` link to the desk, followed by three category bubbles, each opening a menu
  (`lib/piscine/nav.ts` is the single definition):
  - **Work** — Tickets, Spec & Memory, QA, Releases
  - **Agents** — Named agents, Sessions, Chat, Usage
  - **Réglages** — Workspace & Full Auto, Night runs, Notifications, Intégrations
- **right** — `⌘K` command palette, Inbox, Auto, New.

`Now` is a direct destination with no menu; the logo also returns to the desk.

### Screens

| Route | What it is |
|-------|------------|
| `/` | the control desk, unfiltered |
| `/tickets` | the exhaustive registry — the only table view, and the only place `released` tickets are listed |
| `/chat` | chat as a full page (it used to be a resizable side panel) |
| `/qa` | cross-project review findings, verdicts and the rubric |
| `/agents` | the agents workshop — Named agents / Assignments / Prompts / Limits (it used to be a side sheet) |
| `/usage` | cost and quota observatory |
| `/settings` | Paramètres → Workspace: workspace, Full Auto, night runs, notifications, budget. Its siblings are `/settings/pipeline`, `/settings/integrations` and `/settings/appearance` |
| `/inbox` | agent questions awaiting a reply |
| `/projects/:id` | the desk scoped to one project |
| `/projects/:id/spec` | Spec & Memory, agent suggestions, docs, prompt anatomy |
| `/projects/:id/releases` | release composition and history |
| `/projects/:id/sessions` | agent session history for that project |

Ticket state still moves through `backlog → todo → in_progress → review →
to_merge → done → released` (`lib/types/kanban.ts`). Those statuses are live
data — they are simply no longer presented as columns you drag between.

### Design system

The UI is built on "Piscine": colour, radius and typography tokens in
`app/globals.css` (`:root` for day, `.dark` for night), typed lookups in
`lib/piscine/tokens.ts`, and shared primitives in `components/piscine/`.
Typography is Bricolage Grotesque (display), Instrument Sans (UI) and Space
Mono (ids, chronos, counters), loaded and self-hosted through
`next/font/google`.

### One-click build

Select a ticket and dispatch it. Arij will:
1. Create an isolated git worktree and branch
2. Compose a structured prompt from your spec, ticket details, and project context
3. Spawn an AI agent to implement the feature
4. Track the session live in the WORKING stratum
5. Move the ticket to Review when done

### Multi-provider support

Use whichever AI coding tool you prefer:

| Provider | What it uses |
|----------|-------------|
| **Claude Code** | `claude` CLI — primary provider with plan + code modes |
| **OpenAI Codex** | `codex` CLI via Codex SDK |
| **Oh My Pi** | `omp` CLI — standalone multi-agent orchestrator (fork of pi) |
| **Antigravity** | `agy` CLI — Google Antigravity's agent |

Every provider carries Arij's MCP tool channel per session — that is the bar
for being on this list. Agents use it to move tickets, file review findings,
attach artifacts, and ask questions; a CLI that cannot be handed a per-session
MCP config silently degrades all of that, so providers without one were
removed (see `docs/architecture/mcp-provider-matrix.md`). Create "Named
Agents" to mix and match providers and models — e.g., use Claude Opus for
complex builds and a lighter model for quick bug fixes.

### Automated code review

After an agent builds a feature, trigger AI-powered reviews:
- **Security audit** — checks for vulnerabilities
- **Code review** — best practices and quality
- **Compliance check** — accessibility and standards

Findings land in the `review_comments` table and surface in two places: on the
ticket, and aggregated across every project on `/qa`. Nothing on `/qa` approves
a ticket — **the merge is the approval**; the screen only dismisses a finding,
dispatches a fix, or runs another pass.

### Agent session monitoring

Track every AI agent session with detailed status, duration, provider info, and
logs. Live sessions appear in WORKING on the desk; the full history is at
`/projects/:id/sessions`.

### Git automation

Arij handles all the git plumbing:
- **Clone** — import straight from a GitHub URL; Arij clones into its own workspace and sets the project up from there
- **Worktrees** — each ticket gets its own isolated working directory
- **Branches** — automatic branch creation and naming
- **Push & PR** — push to remote and create pull requests from the UI
- **Merge** — merge completed work back to main

### Project specification

Write and edit your project spec in Markdown at `/projects/:id/spec`. It is
automatically injected into agent prompts, and the same page shows the project
memory, agent-written spec suggestions, and the anatomy of the prompt an agent
actually receives.

### Document upload

Upload reference documents (PDF, DOCX, Markdown, images) to your project. Documents are converted to Markdown and available as context for AI agents. Use `@filename` mentions in chat to reference specific docs.

### QA & tech checks

Run AI-powered quality audits on your project. `/qa` collects the findings
across every project; `/projects/:id/qa` is the older per-project exploratory
QA-check agent and its reports.

### Release management

Create releases by selecting completed epics. Arij generates changelogs, creates git tags, and supports GitHub draft releases.

### Dependency management

Set dependencies between epics. Arij builds a DAG and schedules agent work in the correct order — parallel where possible, sequential where required. Dependency-blocked tickets are skipped by UP NEXT and by Full Auto alike.

### Team mode

For large features, enable Team Mode to have a single Claude Code session orchestrate multiple sub-agents working on different tickets simultaneously.

### Full Auto Mode

Arm a project and walk away. Full Auto Mode is a standing supervisor, enabled
**per project** — there is no global switch. The desk's `Full Auto · n/m` pill
opens the per-project checkboxes; the top bar's `Auto` pill is the read-only
roll-up and leads to Réglages. It keeps building everything in To Do, reviewing
everything in Review, and **merging each ticket into `main` as soon as its
review comes back clean** — with separate concurrency budgets for builds and
reviews.

It refuses to touch a ticket another agent already has, and it never overrides a review: an epic with open review findings is left alone until you resolve them. If a merge conflicts, a resolution agent is dispatched and the merge is retried once; a second failure parks the ticket and notifies you. See [docs/architecture/full-auto-mode.md](docs/architecture/full-auto-mode.md) for the full behaviour, the settings keys, and the unattended merge path.

---

## Getting Started

### Prerequisites

- **Node.js** >= 20.9
- **Git** installed
- At least one AI coding CLI:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `npm install -g @anthropic-ai/claude-code`, then `claude auth`
  - [OpenAI Codex](https://github.com/openai/codex) — optional
  - [omp](https://omp.sh) (Oh My Pi) — optional
  - Antigravity (`agy`) — optional

`./install.sh` offers to install the first three for you and registers the
MCP tool channel with every installed CLI, `agy` included.

### Install & Run

```bash
git clone https://github.com/yourorg/arij.git
cd arij
./install.sh
npm run dev
```

Open **http://localhost:3000** in your browser. The database is created automatically on first run.

`install.sh` runs three phases, each skippable with `--skip-app`, `--skip-cli`
or `--skip-mcp`, and `--yes` takes the defaults for an unattended run:

1. **the app** — checks Node and git, `npm install`, creates `data/`
2. **the CLIs** — offers Claude Code, Codex and omp one at a time, skipping any already on your PATH
3. **the channel** — registers Arij's MCP server in each CLI's own config

It is re-runnable: every config write merges into what is already there and
backs the file up first. A config it cannot parse is reported and left alone.

Those MCP entries reference `${ARIJ_MCP_TOKEN}` rather than a literal token —
Arij mints one per session and revokes it when the agent exits, so there is no
long-lived value to write down. The channel comes alive when Arij spawns the
CLI. A CLI you launch by hand has no token, so the Arij server exits
immediately and the CLI carries on without it.

Which providers actually reach the channel, and what was measured to establish
that, is in [docs/architecture/mcp-provider-matrix.md](docs/architecture/mcp-provider-matrix.md).

Prefer to do it by hand? `npm install && npm run dev` is still the whole app.

### Your First Project

1. Create a project at `/projects/new` (the top bar's **New** button is a new *ticket*, not a new project)
2. Give it a name, description, and point it to a local git repository
3. Write a project spec at `/projects/:id/spec` (or let the AI help you generate one from `/chat`)
4. Create tickets: type a title into the desk's linden composer, describe a feature in Chat and turn the reply into an epic, or fill the form at `/tickets/new`
5. Dispatch one — `⇧⏎` in the composer sends it straight to a builder, or open the ticket and hit **Send to Dev**. Arm **Full Auto** for that project and the supervisor does steps 4-onward for everything queued.

Or **Import** an existing codebase — Arij will analyze it and suggest epics automatically.

#### Import from a GitHub URL

**Import** accepts a repository URL as well as a local path. Pick **GitHub URL**, paste any of these, and hit **Import**:

```
https://github.com/owner/repo
https://github.com/owner/repo/tree/main     # browser URLs work, the suffix is dropped
git@github.com:owner/repo.git
owner/repo                                   # shorthand
```

Arij then:

1. **Clones** the repository into its own workspace — `<arij>/projects/<owner>-<repo>` by default
2. **Analyzes** the clone with the same pipeline a local import uses (an existing `arji.json` short-circuits the AI analysis)
3. Shows you the **preview** of epics and user stories to edit before creating the project

The project is created already connected to GitHub: push, PR creation, releases and issue sync work immediately, with no separate "Connect GitHub" step.

Notes:

- **Private repositories** need a GitHub PAT — set it in **Paramètres → Intégrations** (`/settings/integrations`). The token is only sent when an anonymous attempt is refused, and it is never written to `.git/config`, so `origin` keeps a clean URL. Public repositories clone with no token at all.
- **Clones are full clones** — no `--depth`, no `--single-branch`. Arij creates worktrees off the default branch, computes merge bases and tags releases, and all of that needs the complete history. Expect the clone of a large repository to take a while; the UI shows "Cloning repository..." as its own step.
- **Re-importing the same repository is safe.** If the destination already holds that repository, Arij fetches it instead of re-cloning. If it holds something else, the import stops with a conflict and tells you what is in the way — nothing is ever overwritten.
- Only directories Arij created itself are ever treated as Arij's to remove. A project you pointed at a local path is never touched.

### Configuration

#### Where clones land

Cloned repositories go to `<arij>/projects/` — the directory next to `data/`, gitignored, created on first use. Each clone is `<projects root>/<owner>-<repo>`, and their worktrees sit alongside in `<projects root>/.arij-worktrees`.

To keep your code elsewhere, set the projects directory in **Paramètres → Workspace** (`/settings`), stored as the `projects_root` setting. Only an absolute path is accepted — a relative one would move with the directory Arij runs from, so it is refused and the default is used instead. Clearing the field restores the default.

#### Credentials

GitHub credentials live in **Paramètres**, not in the environment: the PAT is stored in the `settings` table of the local SQLite database, and read from there by every GitHub feature (clone, push, PR, releases, issue sync).

> The `GITHUB_TOKEN` environment variable is **not** read by Arij. If you set it in an older `.env.local`, it has no effect — move the token to Paramètres → Intégrations.

Create `.env.local` for optional settings:

```env
# Custom Claude CLI path
CLAUDE_PATH=/usr/local/bin/claude
```

Customize agent behavior on the **`/agents`** workshop:
- **Named agents** — create provider+model combinations for different tasks
- **Assignments** — set which agent handles each of the 21 roles
- **Prompts** — edit the role prompts and the review agents
- **Limits** — runtime limits and the review-bounce readout

---

## How It Works

```
You describe a feature (composer, Chat, or /tickets/new)
        |
        v
  Arij creates an epic with user stories
        |
        v
  You dispatch it — or Full Auto picks it off UP NEXT
        |
        v
  Arij creates a git worktree + branch
        |
        v
  AI agent implements the feature
        |
        v
  Ticket reaches Review; findings land on the ticket and on /qa
        |
        v
  It surfaces in READY TO LAND once the merge would succeed
        |
        v
  You merge to main — merging is the approval
```

All agent work happens in isolated git worktrees, so multiple features can be built in parallel without conflicts.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16 (App Router, Turbopack) |
| UI | React 19, Tailwind CSS v4 + shadcn/ui |
| Design system | "Piscine" — CSS custom-property tokens in `app/globals.css`, primitives in `components/piscine/` |
| Typography | Bricolage Grotesque / Instrument Sans / Space Mono via `next/font/google` |
| Database | SQLite via better-sqlite3 + Drizzle ORM |
| Agent execution | Claude Code CLI (`claude`) spawned as a child process — plus Codex, Oh My Pi, and Antigravity |

---

## Architecture

Arij is a single local Next.js app — no external services:

- **Web UI** — App Router pages render the control desk, the ticket overlay, the ticket registry and the Chat page, all under one global top bar (`app/`, `components/`).
- **API routes** — server-side route handlers orchestrate planning, builds, reviews, and git operations (`app/api/`). The desk reads one of them, `GET /api/control-desk`, on a single poll.
- **Provider layer** — each AI CLI (Claude Code, Codex, omp, agy) is wrapped in a provider that spawns the tool as a child process and parses its output (`lib/providers/`, `lib/claude/`).
- **Database** — a local SQLite file managed with Drizzle ORM stores projects, epics, stories, sessions, review comments, and chat history (`lib/db/`). `arji.json` is the board export written back out of it (`lib/sync/arji-json.ts`).
- **Workflow layer** — queue ranks, merge readiness, status transitions and filters live in `lib/kanban/` and `lib/workflow/`; the desk, the registry and the Full Auto supervisor all call the same helpers so they can never disagree about a ticket's state.
- **Git layer** — every build runs in its own git worktree on a dedicated branch, keeping parallel agent work isolated until you merge (`lib/git/`).

---

## Production Build

```bash
npm run build
npm run start
```

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit with conventional commits: `feat(scope): description`
4. Push and open a pull request

---

## License

[MIT](LICENSE)
