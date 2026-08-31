# Arji — Comprehensive Technical Audit Report

**Date:** 2026-02-23
**Scope:** Full codebase health audit across architecture, code quality, performance, security, testing, and technical debt.

> **Historical record — 2026-08-31.** The UI described below was replaced by the attention-strata control-desk redesign; this file is kept as written on its date and has not been revised. Current UI: `README.md`, `docs/specs.md`.

---

## Executive Summary

Arji is a well-structured Next.js 16 local-first AI orchestrator with clear layer separation (database → services → API → components), a strong provider abstraction for multi-CLI support, and type-safe database access via Drizzle ORM. The codebase demonstrates good architectural foundations with consistent use of TypeScript strict mode, the `@/` import alias, Zod validation, and shadcn/ui composition patterns.

However, the audit identified **42 findings across 6 categories** that span from critical security gaps to low-severity code hygiene items. The most urgent concerns are: (1) information disclosure via error responses leaking internal paths, stack traces, and debug data; (2) N+1 query patterns in export/import that scale to 250+ queries; (3) oversized files (prompt-builder.ts at 1,375 lines, chat/stream route at 565 lines) that violate single-responsibility; and (4) absence of structured logging with 55+ `console.log` calls in production code.

The project is in solid shape for its stage of development. None of the findings indicate fundamental architectural flaws — they are refinements that will improve maintainability, debuggability, and resilience as the project scales. The prioritized action plan at the end of this report organizes all findings into 4 implementation phases.

---

## 1. Architecture & Patterns

### Overall Assessment: 7.5/10

**Strengths:**
- Clear layer separation: `/lib/db` (data), `/lib/providers` (services), `/app/api` (HTTP), `/components` (UI), `/hooks` (client state)
- Provider abstraction (`AgentProvider` interface + `BaseCliProvider` base class) enables swappable CLI backends (Claude Code, Codex, Gemini CLI)
- Drizzle ORM provides compile-time DB schema safety with parameterized queries
- Consistent `@/` import alias usage across entire codebase
- Event emission pattern decouples sessions from notifications

**Architecture Diagram:**
```
┌─ Frontend (React 19 + shadcn/ui + dnd-kit)
│  ├─ /app (pages, layouts)
│  ├─ /components (kanban, chat, dashboard)
│  └─ /hooks (data fetching, state management)
│
├─ API Routes (/app/api)
│  ├─ chat/stream (SSE streaming, multi-provider)
│  ├─ projects/* (CRUD + operations)
│  └─ agent-config/* (provider/prompt configuration)
│
└─ Backend Services (/lib)
   ├─ db/ (Drizzle ORM + schemas + backfills)
   ├─ claude/ (spawn, streaming, logging)
   ├─ providers/ (AgentProvider abstraction + 7 implementations)
   ├─ agent-config/ (named agents, prompts, defaults)
   ├─ notifications/ (event-driven creation + pruning)
   ├─ events/ (event bus + emit helpers)
   └─ validation/ (Zod schemas, path validation)
```

### Findings

#### A1. Chat Stream Route Is a God Object
- **Severity:** High
- **File:** `app/api/projects/[projectId]/chat/stream/route.ts` (~565 lines)
- **Description:** This single route file handles provider selection, conversation state management, message persistence, prompt building, streaming response assembly, title generation, and error handling. It imports from 10+ lib modules.
- **Recommendation:** Extract into a service layer (`lib/chat/service.ts`) with focused functions: `resolveProvider()`, `buildChatContext()`, `streamResponse()`, `persistConversation()`.

#### A2. Oversized EpicDetail Component
- **Severity:** Medium
- **File:** `components/kanban/EpicDetail.tsx` (776 lines, 13+ event handlers)
- **Description:** Contains merge logic, review logic, metadata editing, user stories list, and inline editing all in one component. Props interface has 15+ fields.
- **Recommendation:** Extract into `EpicMergeSection`, `EpicReviewSection`, `EpicMetadataEditor`, `EpicUserStoriesList` subcomponents.

#### A3. Prop Drilling in Kanban Tree
- **Severity:** Medium
- **Files:** `Board.tsx` → `Column.tsx` → `EpicCard.tsx`
- **Description:** `activeAgentActivity`, `onLinkedAgentHoverChange`, `failedSession`, `onRetry` are passed through 3 levels. Adding new shared state requires changes across all 3 components.
- **Recommendation:** Introduce a `KanbanContext` or Zustand store for board-level shared state (per CLAUDE.md: "Pas de prop drilling >2 niveaux").

#### A4. useKanban Hook Manages Too Many Concerns
- **Severity:** Medium
- **File:** `hooks/useKanban.ts` (217 lines)
- **Description:** Single hook manages board state, drag-and-drop reordering, selection state, active session polling, and failed session tracking.
- **Recommendation:** Decompose into `useBoardEpics()`, `useKanbanSelection()`, `useKanbanDragDrop()`.

#### A5. Dynamic `require()` in ESM Codebase
- **Severity:** Low
- **File:** `lib/db/index.ts` (lines 93-125)
- **Description:** Uses CommonJS `require()` to avoid circular imports with backfill modules. Breaks static analysis and tree-shaking. Type information is lost.
- **Recommendation:** Use `await import()` in an explicit async initialization function, or restructure to break the circular dependency.

#### A6. Feature Flags Embedded in Code
- **Severity:** Low
- **File:** Provider selection logic
- **Description:** `RESUME_CAPABLE_PROVIDERS` is a hardcoded `Set<ProviderType>`. Provider capabilities should be queryable from the provider interface itself.
- **Recommendation:** Add `supportsResume: boolean` to `AgentProvider` interface.

---

## 2. Code Quality

### Overall Assessment: 7/10

**Strengths:**
- TypeScript strict mode enabled (`strict: true` in tsconfig.json)
- Consistent naming: PascalCase components, camelCase functions, UPPER_SNAKE_CASE constants
- Minimal code duplication thanks to `BaseCliProvider` and shared prompt builders
- Zod validation schemas for request/response validation

### Findings

#### Q1. Excessive Console Logging in Production Code
- **Severity:** High
- **Files:** 55+ occurrences across `lib/codex/spawn.ts`, `lib/claude/spawn.ts`, `lib/db/index.ts`, `app/api/projects/route.ts`, and many others
- **Description:** Production code uses `console.log`, `console.warn`, `console.error` directly. No centralized logging mechanism despite `lib/claude/logger.ts` existing for session logging. Logs include potentially sensitive information (cwd, command args, prompts).
- **Recommendation:** Implement structured logging via `pino` or `structlog`. Replace all `console.*` calls with a centralized logger with appropriate levels (debug, info, warn, error). Sanitize sensitive data before logging.

#### Q2. Silent Error Handling in Critical Paths
- **Severity:** Medium
- **Files:** `lib/db/index.ts` (lines 97, 111, 122), `lib/providers/base-provider.ts` (lines 202, 236, 256, 315), multiple API routes
- **Description:** Empty `catch {}` blocks with comments like `/* best-effort */` suppress errors silently. Violates "fail fast" principle from project guidelines. Makes production debugging very difficult.
- **Recommendation:** Replace silent catches with structured logging:
  ```typescript
  catch (error) {
    logger.warn("Backfill failed (non-critical)", { error: String(error) });
  }
  ```

#### Q3. Inconsistent Error Response Formatting
- **Severity:** Medium
- **Files:** Multiple API routes
- **Description:** Some routes use `new Response(JSON.stringify({ error }))`, others use `NextResponse.json({ error })`. Error field names vary (`error`, `details`). No consistent HTTP status code mapping.
- **Recommendation:** Create `lib/api/response.ts` with standardized helpers:
  ```typescript
  export const apiError = (message: string, status = 400) =>
    NextResponse.json({ error: message }, { status });
  ```

#### Q4. `no-explicit-any` ESLint Rule Disabled
- **Severity:** Low
- **File:** `eslint.config.mjs` (line 10)
- **Description:** `@typescript-eslint/no-explicit-any` is set to `"off"` globally. While TypeScript strict mode is enabled, this allows bypassing type safety at the linting level.
- **Recommendation:** Change to `"warn"` to encourage type safety while allowing exceptions.

#### Q5. `as any` Casts in Test Files
- **Severity:** Low
- **Files:** `lib/validation/__tests__/path.test.ts`, `__tests__/notifications-schema.test.ts`, `__tests__/notifications-api.test.ts`, `__tests__/github-release-*.test.ts`
- **Description:** 36+ `as any` type assertions in test files, particularly when casting mock requests (`req as any`).
- **Recommendation:** Create proper typed mock utilities or use `satisfies` with proper interfaces.

#### Q6. Inconsistent Error Variable Naming
- **Severity:** Low
- **Files:** Scattered across codebase
- **Description:** Catch blocks use `error`, `err`, `e`, `_error` inconsistently.
- **Recommendation:** Standardize on `error` for all catch blocks.

---

## 3. Performance

### Overall Assessment: 6.5/10

**Strengths:**
- Good use of Drizzle ORM type safety and parameterized queries
- Proper foreign key constraints with CASCADE
- Streaming SSE responses correctly implemented
- Hooks are well-structured with proper cleanup

### Findings

#### P1. N+1 Query in Export Function
- **Severity:** High
- **File:** `lib/sync/export.ts` (lines 22-68)
- **Description:** For each epic, executes separate queries for user stories and comments. For each user story, executes another query for story comments. With 50 epics and 200 stories: **251+ database queries**.
  ```typescript
  allEpics.map((epic) => {
    const stories = db.select()...where(eq(userStories.epicId, epic.id)).all();
    const epicComments = db.select()...where(eq(ticketComments.epicId, epic.id)).all();
    stories.map((us) => {
      const storyComments = db.select()...where(eq(ticketComments.userStoryId, us.id)).all();
    });
  });
  ```
- **Recommendation:** Batch-load all user stories and comments in 2-3 queries, then group by ID in memory.

#### P2. N+1 Query in Import Function
- **Severity:** High
- **File:** `lib/sync/import.ts` (lines 56-149)
- **Description:** Inside a transaction, executes N queries to fetch current story IDs (one per epic) plus M upsert queries (one per story).
- **Recommendation:** Fetch all current story IDs once using `IN (epicIdList)` before the loop.

#### P3. Unoptimized Chat Stream Queries
- **Severity:** High
- **File:** `app/api/projects/[projectId]/chat/stream/route.ts`
- **Description:** Multiple issues: (1) `.orderBy(desc()).all().reverse()` — reverses in JS after DESC sort; (2) counts messages by fetching all IDs and using `.length` instead of `count()`; (3) no index on `chatMessages(conversationId, createdAt)`.
- **Recommendation:** Use `asc()` order directly, use SQL `count()`, add composite index.

#### P4. Missing Composite Indexes
- **Severity:** High
- **File:** `lib/db/schema.ts`
- **Description:** `notifications` table has only a single-column index on `createdAt`. `ticketActivityLog` lacks composite index for the common `projectId + epicId + createdAt` query. `chatMessages` lacks index on `(conversationId, createdAt)`.
- **Recommendation:** Add composite indexes on frequently queried column combinations.

#### P5. Missing Indexes on Foreign Key Columns
- **Severity:** Medium
- **File:** `lib/db/schema.ts`
- **Description:** Several FK columns lack indexes: `chatMessages.conversationId`, `chatAttachments.chatMessageId`, `epics.linkedEpicId`, `epics.releaseId`. Slows CASCADE DELETE and FK constraint checks.
- **Recommendation:** Add indexes on all frequently queried FK columns.

#### P6. Unbounded Chat History Query
- **Severity:** Medium
- **File:** `app/api/projects/[projectId]/chat/route.ts` (lines 30-45)
- **Description:** Fetches ALL messages for a conversation with no LIMIT. Memory grows linearly with conversation length.
- **Recommendation:** Add pagination with sensible defaults (e.g., last 100 messages).

#### P7. Kanban Board Re-renders All Columns on Move
- **Severity:** Medium
- **File:** `hooks/useKanban.ts` (lines 117-134)
- **Description:** `moveEpic` copies ALL 6 columns on every move (not just affected ones). Uses 300ms `setTimeout` instead of proper debounce. No rollback if API fails.
- **Recommendation:** Only copy affected columns. Use a proper debounce utility. Add optimistic rollback.

#### P8. Notification Pruning Double-Scans Table
- **Severity:** Medium
- **File:** `lib/notifications/create.ts` (lines 126-141)
- **Description:** Runs `SELECT COUNT(*)` then `DELETE ... WHERE id NOT IN (SELECT ... LIMIT N)` — two full table scans.
- **Recommendation:** Single DELETE with offset-based subquery.

#### P9. Multiple Polling Intervals Cause Network Churn
- **Severity:** Low
- **Files:** `hooks/useNotifications.ts` (5s interval), `hooks/useAgentPolling.ts` (3s interval)
- **Description:** Two independent polling loops running simultaneously. Could be consolidated.
- **Recommendation:** Use a single unified polling mechanism with exponential backoff.

#### P10. Per-Card Elapsed Time Intervals
- **Severity:** Low
- **File:** `components/kanban/EpicCard.tsx` (lines 117-128)
- **Description:** Each card with an active agent creates its own `setInterval(1000)`. With 20+ active cards, that's 20+ intervals per second.
- **Recommendation:** Use a single shared timer at the board level and broadcast via context.

#### P11. SQLite WAL Mode Lacks Tuning
- **Severity:** Low
- **File:** `lib/db/index.ts`
- **Description:** WAL mode enabled but no `synchronous`, `cache_size`, or `temp_store` pragmas set.
- **Recommendation:** Add `synchronous = NORMAL`, `cache_size = -64000`, `temp_store = MEMORY` for better throughput.

---

## 4. Security

### Overall Assessment: 5.5/10

**Strengths:**
- Zod-based input validation on many routes
- Drizzle ORM parameterized queries (preventing SQL injection)
- Local-only middleware enforcement via Host/Origin validation
- File upload MIME type and size restrictions
- `.gitignore` covers `.env*`, `.pem`, `node_modules/`, `.next/`

### Findings

#### S1. Information Disclosure via Error Responses
- **Severity:** Critical
- **Files:** `app/api/projects/import/route.ts` (lines 73-78, 88-97), `app/api/projects/[projectId]/chat/stream/route.ts` (lines 361-376), multiple routes
- **Description:** Error responses expose full filesystem paths, stack traces, raw Claude CLI output, and debug objects:
  ```typescript
  return NextResponse.json({
    error: `File not found at: ${arjiPath}`,  // ← leaks filesystem path
    debug: {
      duration: result.duration,
      rawOutput: result.result?.slice(0, 2000),  // ← leaks AI reasoning
      stack: e instanceof Error ? e.stack : undefined,  // ← leaks code structure
    },
  }, { status: 500 });
  ```
- **Recommendation:** Return generic error messages to clients. Log details server-side only. Never include `debug`, `stack`, `rawOutput` in production responses.

#### S2. No Per-Route Authentication
- **Severity:** High
- **Files:** ALL API routes under `app/api/`
- **Description:** Middleware validates local-only Host/Origin but has no per-user authentication or authorization. Any local process can access all endpoints including settings (GitHub token storage), project deletion, and session management.
- **Recommendation:** For a local-first tool this is partially mitigated by the localhost restriction. However, implement at minimum a session token to prevent cross-origin attacks from other local processes. For multi-user scenarios, add proper auth.

#### S3. Process Spawning with User-Controlled Prompts
- **Severity:** High
- **Files:** `lib/claude/spawn.ts` (line 94), `lib/providers/base-provider.ts` (line 173)
- **Description:** User-controlled prompts are passed as CLI arguments (`--print -p <prompt>`). While `shell: true` is not used (good), argument injection is still a risk if the CLI parser has vulnerabilities.
- **Recommendation:** Prefer stdin for transmitting prompts. If CLI args are required, validate prompt format strictly.

#### S4. Path Traversal Validation Bypass Risk
- **Severity:** High
- **Files:** `app/api/projects/[projectId]/chat/uploads/[attachmentId]/route.ts` (line 24), `app/api/projects/[projectId]/documents/[documentId]/route.ts` (line 28)
- **Description:** File read operations construct paths from database records without re-validating scope:
  ```typescript
  const absolutePath = path.join(process.cwd(), attachment.filePath);
  const fileBuffer = fs.readFileSync(absolutePath);  // ← no scope validation
  ```
- **Recommendation:** Add `path.resolve()` + `startsWith(allowedDir)` check before any file read.

#### S5. GitHub Token Stored in Plaintext
- **Severity:** Medium
- **File:** `app/api/settings/route.ts` (lines 60-72)
- **Description:** GitHub PAT stored as plaintext JSON in SQLite. Anyone with filesystem access to `data/arij.db` can extract credentials.
- **Recommendation:** Encrypt sensitive values with `aes-256-cbc` before storage. Return `{ hasToken: true }` instead of actual token on GET.

#### S6. Missing CORS/CSP Headers
- **Severity:** Medium
- **Description:** No Content-Security-Policy, X-Content-Type-Options, X-Frame-Options, or X-XSS-Protection headers configured.
- **Recommendation:** Add security headers via Next.js config or middleware.

#### S7. Insufficient File Upload Magic Number Validation
- **Severity:** Medium
- **Files:** `app/api/projects/[projectId]/chat/upload/route.ts`, `app/api/projects/[projectId]/documents/route.ts`
- **Description:** MIME type and file size are checked, but file content is not validated against magic bytes. An attacker could upload a malicious file with a spoofed MIME type.
- **Recommendation:** Use the `file-type` library for magic number validation.

#### S8. Missing Input Validation on Stream Route
- **Severity:** Medium
- **File:** `app/api/projects/[projectId]/chat/stream/route.ts` (lines 45-71)
- **Description:** The stream chat route does manual type coercion instead of Zod validation:
  ```typescript
  const body = await request.json();  // ← no schema validation
  const finalize: boolean = body.finalize === true;
  ```
- **Recommendation:** Apply Zod schema validation consistently.

---

## 5. Testing

### Overall Assessment: 6/10

**Strengths:**
- 125+ test files with ~23.6K lines of test code (55% test-to-code ratio)
- Comprehensive test utilities and mock helpers
- Good coverage of validation logic, notification schemas, and hook behavior
- Vitest configured with path aliases and jsdom environment

### Findings

#### T1. 10 Test Files Disabled with `.skip`
- **Severity:** High
- **Files:** Multiple test files containing `describe.skip` or `it.skip`
- **Description:** Disabled tests with no documentation of why. These may hide regressions.
- **Recommendation:** Either fix and re-enable, or document the reason and create tracking issues.

#### T2. No CI Pipeline
- **Severity:** High
- **Description:** No `.github/workflows/` or similar CI configuration found. Tests don't run automatically on commits or PRs.
- **Recommendation:** Add a CI pipeline that runs `npm test`, `npm run lint`, and `npm run build` on every push.

#### T3. Near-Zero Component Test Coverage
- **Severity:** High
- **Description:** Only 2 component test files exist for 100+ React components. The kanban board, chat panel, epic detail, and all dashboard components have no tests.
- **Recommendation:** Add tests for critical UI components using React Testing Library, prioritizing: `EpicDetail`, `Board`, `UnifiedChatPanel`.

#### T4. Missing Error Path Tests for Major Routes
- **Severity:** Medium
- **Files:** Build route, chat route, releases route
- **Description:** Happy-path coverage exists but error scenarios (invalid input, provider failures, database constraints) are not tested.
- **Recommendation:** Add error path tests for each major API route.

#### T5. Timing-Dependent Tests
- **Severity:** Medium
- **Files:** 14 tests using `setTimeout` or time-dependent assertions
- **Description:** Tests relying on specific timing may be flaky in CI environments.
- **Recommendation:** Use `vi.useFakeTimers()` for time-dependent tests.

#### T6. No Coverage Thresholds
- **Severity:** Low
- **Description:** No coverage thresholds configured in vitest. No visibility into which code paths are untested.
- **Recommendation:** Add `coverage` configuration with `80%` threshold for critical logic paths.

---

## 6. Technical Debt

### Findings

#### D1. Prompt Builder Is 1,375 Lines
- **Severity:** High
- **File:** `lib/claude/prompt-builder.ts`
- **Description:** Single file handles all prompt generation (chat, build, epic, refinement, review, etc.). Difficult to test individual prompt types.
- **Recommendation:** Split into focused modules: `chat-prompts.ts`, `build-prompts.ts`, `review-prompts.ts`.

#### D2. Incomplete Deprecated Field Migration
- **Severity:** Medium
- **Description:** `claudeSessionId` field appears in 30+ files despite being superseded by `agentSessionId` in the schema. Indicates a partial migration.
- **Recommendation:** Complete the migration: rename all references, add a deprecation backfill if needed.

#### D3. Module-Level Side Effects in DB Init
- **Severity:** Medium
- **File:** `lib/db/index.ts`
- **Description:** Database backfills run as side effects on module import. Uses `require()` to work around circular imports. Silent error handling.
- **Recommendation:** Extract to explicit `initializeDatabase()` async function called at app startup.

#### D4. Outdated Dependencies
- **Severity:** Low
- **Description:** Some dependencies may be behind (vitest, @types/node, jsdom). No automated dependency update tool configured.
- **Recommendation:** Add Dependabot or Renovate. Run `npm audit` in CI.

#### D5. Commented-Out Code and Dead Routes
- **Severity:** Low
- **Description:** Some files contain commented-out code blocks from previous iterations.
- **Recommendation:** Remove commented-out code. Use git history for reference.

---

## Prioritized Action Plan

### Phase 1: Critical Fixes (Immediate — 1-2 days)

| # | Finding | Impact | Effort |
|---|---------|--------|--------|
| 1 | S1: Remove debug data and stack traces from error responses | Security | 2h |
| 2 | P1+P2: Fix N+1 queries in export/import | Performance | 3h |
| 3 | P4: Add composite indexes | Performance | 1h |
| 4 | Q1: Implement structured logging (replace console.*) | Reliability | 4h |
| 5 | T2: Add CI pipeline | Quality | 2h |

### Phase 2: High-Priority Improvements (1-2 weeks)

| # | Finding | Impact | Effort |
|---|---------|--------|--------|
| 6 | A1: Extract chat stream service layer | Maintainability | 6h |
| 7 | S4: Add path scope validation on file reads | Security | 2h |
| 8 | S8: Add Zod validation to stream route | Security | 1h |
| 9 | Q2: Replace silent catch blocks with structured logging | Reliability | 3h |
| 10 | P3: Optimize chat stream queries | Performance | 2h |
| 11 | D1: Split prompt-builder.ts | Maintainability | 4h |
| 12 | T1: Fix or document skipped tests | Quality | 3h |
| 13 | P5: Add FK indexes | Performance | 1h |

### Phase 3: Medium-Priority Refinements (2-4 weeks)

| # | Finding | Impact | Effort |
|---|---------|--------|--------|
| 14 | A2: Break down EpicDetail component | Maintainability | 4h |
| 15 | A3: Introduce KanbanContext | Maintainability | 3h |
| 16 | S5: Encrypt GitHub token storage | Security | 2h |
| 17 | S6: Add CORS/CSP security headers | Security | 1h |
| 18 | P6: Add chat history pagination | Performance | 3h |
| 19 | T3: Add component tests for critical UI | Quality | 8h |
| 20 | T4: Add error path tests for major routes | Quality | 4h |
| 21 | D2: Complete claudeSessionId migration | Tech Debt | 4h |
| 22 | Q3: Standardize error response format | Code Quality | 2h |

### Phase 4: Low-Priority Polish (Ongoing)

| # | Finding | Impact | Effort |
|---|---------|--------|--------|
| 23 | A4: Decompose useKanban hook | Maintainability | 3h |
| 24 | P7: Optimize kanban moveEpic | Performance | 2h |
| 25 | P9: Unify polling intervals | Performance | 2h |
| 26 | P11: Tune SQLite pragmas | Performance | 30m |
| 27 | S7: Add file upload magic number validation | Security | 1h |
| 28 | T5: Fix timing-dependent tests | Quality | 2h |
| 29 | T6: Add coverage thresholds | Quality | 30m |
| 30 | Q4: Set no-explicit-any to "warn" | Code Quality | 30m |
| 31 | D4: Set up Dependabot/Renovate | Tech Debt | 1h |

---

## Finding Count by Severity

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 13 |
| Medium | 17 |
| Low | 11 |
| **Total** | **42** |

## Finding Count by Category

| Category | Count |
|----------|-------|
| Architecture & Patterns | 6 |
| Code Quality | 6 |
| Performance | 11 |
| Security | 8 |
| Testing | 6 |
| Technical Debt | 5 |

---

*Report generated by comprehensive codebase audit with 5 parallel analysis agents covering architecture, code quality, performance, security, and testing.*
