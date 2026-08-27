# Arij — Development Guidelines

## Project Overview
Arij is a local, AI-first project orchestrator. It provides a web interface for managing multi-project workflows with Claude Code as the execution engine.

## Stack
- **Framework**: Next.js 16 (App Router, Turbopack)
- **UI**: Tailwind CSS v4 + shadcn/ui
- **Database**: SQLite via better-sqlite3 + Drizzle ORM
- **Kanban DnD**: dnd-kit
- **Claude Code**: CLI `claude` spawned as child process

## Conventions
- Use `@/` import alias for project root
- Use `nanoid` for all IDs (`lib/utils/nanoid.ts`)
- API routes return JSON with consistent `{ data }` or `{ error }` shape
- Database schema in `lib/db/schema.ts`, connection in `lib/db/index.ts`
- Dark mode is default (class-based via Tailwind)
- Components use shadcn/ui primitives from `components/ui/`

## File Structure
- `app/` — Next.js routes and layouts
- `components/` — React components (kanban, chat, dashboard, etc.)
- `lib/` — Server-side utilities (db, claude, converters)
- `hooks/` — Client-side React hooks
- `data/` — Local data (SQLite DB, session logs) — gitignored
- `projects/` — App-managed clones of repositories imported from GitHub
  (`<owner>-<repo>`), plus the `.arij-worktrees` their worktrees land in —
  gitignored. Root resolved by `lib/projects/workspace.ts`; override with the
  `projects_root` setting. Not to be confused with `app/projects/` or
  `lib/projects/`, which are tracked source.

## Commands
- `npm run dev` — Start dev server with Turbopack
- `npm test` — Vitest suite; `npm run test:e2e` — Playwright
- `npx drizzle-kit push` — Push schema to DB

## Migrations
Migrations are **hand-written**. Do not run `npx drizzle-kit generate`: the
`lib/db/migrations/meta/*_snapshot.json` files stop at 0013 while the journal
is far ahead, so generate would diff against stale state and emit wrong DDL.
Add a numbered `.sql` file and append an entry to `meta/_journal.json` by hand.
Journal order and the `when` timestamps must both increase — drizzle only
applies a migration whose `when` exceeds the last one recorded in the database.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
