# Arij

**Your AI-powered project manager that actually writes the code.**

Arij is a local-first web app that lets you plan, organize, and build software projects using AI coding agents like Claude Code, OpenAI Codex, or Gemini CLI. Describe what you want, and Arij orchestrates the AI to implement it — managing git branches, worktrees, code reviews, and merges automatically.

Everything runs on your machine. No cloud. No account. No telemetry.

![Dashboard](public/screenshots/dashboard.png)

---

## Why Arij?

Most AI coding tools work at the file level — you prompt, you get code, you paste it in. Arij works at the **project level**:

- **You describe features as epics**, not individual prompts
- **AI agents build, review, and merge** code in isolated git worktrees
- **A Kanban board** tracks progress from backlog to done
- **Multiple AI providers** can work in parallel on different tasks
- **Everything is local** — your code never leaves your machine

---

## Features

### Kanban Board

Organize your work into epics and bugs across workflow columns: Backlog, To Do, In Progress, Review, and Done. Drag and drop to reprioritize. Bug tickets are highlighted in red for quick identification.

![Kanban Board](public/screenshots/kanban.png)

### Epic Detail & Actions

Click any card to open its detail panel alongside the board. See the description, priority, status, user stories, and dependencies. Hit **"Send to Dev"** to dispatch an AI agent, or **"Build all"** to build multiple selected epics in parallel.

![Ticket Detail](public/screenshots/ticket.png)

### AI Chat Panel

Brainstorm ideas, create new epics, or refine your project spec — all through a chat interface powered by Claude Code (or another provider). The chat panel lives alongside the Kanban board in a resizable split view with tabbed conversations.

![Chat Panel](public/screenshots/chat.png)

### One-Click Build

Select an epic and hit "Build". Arij will:
1. Create an isolated git worktree and branch
2. Compose a structured prompt from your spec, epic details, and project context
3. Spawn an AI agent to implement the feature
4. Track the session in real-time
5. Move the card to Review when done

### Multi-Provider Support

Use whichever AI coding tool you prefer:

| Provider | What it uses |
|----------|-------------|
| **Claude Code** | `claude` CLI — primary provider with plan + code modes |
| **OpenAI Codex** | `codex` CLI via Codex SDK |
| **Gemini CLI** | `gemini` CLI via Google |
| **OpenCode** | `opencode` CLI — open-source, supports any model |
| **Qwen Code** | `qwen` CLI — Alibaba's coding agent |
| **Pi** | `pi` CLI — minimal terminal harness, runs any provider's models |
| **Oh My Pi** | `omp` CLI — standalone multi-agent orchestrator (fork of pi) |
| **Any CLI agent** | Any tool that accepts a `--prompt` flag works out of the box |

Arij's provider system is designed to be extensible — if your favorite AI coding CLI accepts a prompt and outputs results, it can plug into Arij. Create "Named Agents" to mix and match providers and models — e.g., use Claude Opus for complex builds, Gemini Flash for quick bug fixes, or a local model via OpenCode for privacy-sensitive tasks.

### Automated Code Review

After an agent builds a feature, trigger AI-powered reviews:
- **Security audit** — checks for vulnerabilities
- **Code review** — best practices and quality
- **Compliance check** — accessibility and standards

Review results are posted as comments on the epic.

### Agent Session Monitoring

Track every AI agent session with detailed status, duration, provider info, and logs. See what's running, what's completed, and what failed.

### Git Automation

Arij handles all the git plumbing:
- **Clone** — import straight from a GitHub URL; Arij clones into its own workspace and sets the project up from there
- **Worktrees** — each epic gets its own isolated working directory
- **Branches** — automatic branch creation and naming
- **Push & PR** — push to remote and create pull requests from the UI
- **Merge** — merge completed work back to main

### Project Specification

Write and edit your project spec in Markdown. Use it as context for all AI interactions — the spec is automatically injected into agent prompts so the AI always understands your project.

### Document Upload

Upload reference documents (PDF, DOCX, Markdown, images) to your project. Documents are converted to Markdown and available as context for AI agents. Use `@filename` mentions in chat to reference specific docs.

### QA & Tech Checks

Run AI-powered quality audits on your entire project. Get a detailed report and create epics directly from the findings.

### Release Management

Create releases by selecting completed epics. Arij generates changelogs, creates git tags, and supports GitHub draft releases.

### Dependency Management

Set dependencies between epics. Arij builds a DAG and schedules agent work in the correct order — parallel where possible, sequential where required.

### Team Mode

For large features, enable Team Mode to have a single Claude Code session orchestrate multiple sub-agents working on different tickets simultaneously.

### Full Auto Mode

Arm the board and walk away. Full Auto Mode is a standing supervisor, enabled per project from the **Auto** button on the board toolbar: it keeps building everything in To Do, reviewing everything in Review, and **merging each ticket into `main` as soon as its review comes back clean** — with separate concurrency budgets for builds and reviews.

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
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) — optional

`./install.sh` offers to install the first three for you.

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

1. Click **"+ New Project"** on the dashboard
2. Give it a name, description, and point it to a local git repository
3. Write a project spec (or let the AI help you generate one via Chat)
4. Create epics by chatting with the AI — describe what you want and click "Create Epic & Generate Stories"
5. Drag epics to "To Do" and hit **Build** to start an agent

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
2. **Analyzes** the clone with the same pipeline a local import uses (an existing `arij.json` short-circuits the AI analysis)
3. Shows you the **preview** of epics and user stories to edit before creating the project

The project is created already connected to GitHub: push, PR creation, releases and issue sync work immediately, with no separate "Connect GitHub" step.

Notes:

- **Private repositories** need a GitHub PAT — set it in **Settings → GitHub PAT**. The token is only sent when an anonymous attempt is refused, and it is never written to `.git/config`, so `origin` keeps a clean URL. Public repositories clone with no token at all.
- **Clones are full clones** — no `--depth`, no `--single-branch`. Arij creates worktrees off the default branch, computes merge bases and tags releases, and all of that needs the complete history. Expect the clone of a large repository to take a while; the UI shows "Cloning repository..." as its own step.
- **Re-importing the same repository is safe.** If the destination already holds that repository, Arij fetches it instead of re-cloning. If it holds something else, the import stops with a conflict and tells you what is in the way — nothing is ever overwritten.
- Only directories Arij created itself are ever treated as Arij's to remove. A project you pointed at a local path is never touched.

### Configuration

#### Where clones land

Cloned repositories go to `<arij>/projects/` — the directory next to `data/`, gitignored, created on first use. Each clone is `<projects root>/<owner>-<repo>`, and their worktrees sit alongside in `<projects root>/.arij-worktrees`.

To keep your code elsewhere, set **Settings → Projects Directory**, stored as the `projects_root` setting. Only an absolute path is accepted — a relative one would move with the directory Arij runs from, so it is refused and the default is used instead. Clearing the field restores the default.

#### Credentials

GitHub credentials live in **Settings**, not in the environment: the PAT is stored in the `settings` table of the local SQLite database, and read from there by every GitHub feature (clone, push, PR, releases, issue sync).

> The `GITHUB_TOKEN` environment variable is **not** read by Arij. If you set it in an older `.env.local`, it has no effect — move the token to Settings → GitHub PAT.

Create `.env.local` for optional settings:

```env
# Custom Claude CLI path
CLAUDE_PATH=/usr/local/bin/claude
```

Customize agent behavior through the **Agent Configuration** panel in the sidebar:
- **Prompts** — edit system prompts per agent type (build, review, chat, etc.)
- **Named Agents** — create provider+model combinations for different tasks
- **Provider Defaults** — set which agent handles each type of work

---

## How It Works

```
You describe a feature
        |
        v
  Arij creates an epic with user stories
        |
        v
  You click "Build"
        |
        v
  Arij creates a git worktree + branch
        |
        v
  AI agent implements the feature
        |
        v
  Card moves to "Review"
        |
        v
  You trigger AI code review
        |
        v
  You merge to main
```

All agent work happens in isolated git worktrees, so multiple features can be built in parallel without conflicts.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16 (App Router, Turbopack) |
| UI | React 19, Tailwind CSS v4 + shadcn/ui |
| Kanban drag & drop | dnd-kit |
| Database | SQLite via better-sqlite3 + Drizzle ORM |
| Agent execution | Claude Code CLI (`claude`) spawned as a child process — plus Codex, Gemini, and other CLI providers |

---

## Architecture

Arij is a single local Next.js app — no external services:

- **Web UI** — App Router pages render the dashboard, Kanban board, and the Chat Panel (`app/`, `components/`).
- **API routes** — server-side route handlers orchestrate planning, builds, reviews, and git operations (`app/api/`).
- **Provider layer** — each AI CLI (Claude Code, Codex, Gemini, …) is wrapped in a provider that spawns the tool as a child process and parses its output (`lib/providers/`, `lib/claude/`).
- **Database** — a local SQLite file managed with Drizzle ORM stores projects, epics, stories, sessions, and chat history (`lib/db/`).
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
