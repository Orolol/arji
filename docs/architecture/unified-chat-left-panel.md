# Chat surfaces and the unified-chat data contract

*Rewritten 2026-08-31 for the UI rebuild. The original document described one
surface, "the unified chat left panel". That panel is not gone, but it is no
longer the only chat surface, and its two documented entry points no longer
exist. The document is kept rather than superseded because the parity contract
and the cutover migration below are recorded nowhere else, and both are still
live code.*

## Two surfaces, one data path

| Surface | Code | Where |
|---|---|---|
| **Chat page** (primary) | `app/chat/page.tsx` → `components/chat-page/ChatPageView.tsx` | `/chat`, reached from the top bar's **Agents** menu (`lib/piscine/nav.ts`) |
| **Unified chat panel** (survivor) | `components/chat/UnifiedChatPanel.tsx` | wraps the desk on `/projects/:projectId` only |

They are separate component trees. They are not separate data paths: both drive
`hooks/useConversations` and `hooks/useChat`, so they read and write the same
conversations and the same messages.

### The chat page

`/chat` is a server page that only awaits `searchParams` and passes `?project=`
and `?conversation=` down as props — the client view registers no
`useSearchParams()`, so the route needs no Suspense boundary. It mounts
`TicketOverlayProvider`, because tickets produced in a conversation open as the
6a overlay directly from the thread.

Three columns: `ConversationRoster`, the `ChatThread` + `ChatComposer`, and
`ContextRail`. There is no header of its own — `components/piscine/TopBar.tsx`
is mounted once by `app/layout.tsx` — and no second control row: the project
pill inside the composer is the scope control. Escape is deliberately
unhandled; the overlay provider owns it while a ticket is open.

An epic created from a conversation is rendered inside the thread as an
actionable card (`components/chat-page/DraftedEpicCard.tsx`, attached to its
message by `epicsByMessageId` in `components/chat-page/message-epics.ts`), and
the `ContextRail` /
`CreatedHereCard` list what the conversation has produced.

### The panel that survives

`UnifiedChatPanel` still wraps the control desk on `/projects/:projectId`
(`app/projects/[projectId]/page.tsx`), collapsing to a vertical strip
(`data-testid="collapsed-chat-strip"`). Its entry points are **not** the two
buttons the previous version of this document listed — there is no `Chat`
button and no `New Epic` button on that page any more. What opens it now:

- the strip itself;
- `?panel=chat` and `?panel=new-epic`, pushed by the **New** menu the project
  layout still draws on the board route (`app/projects/[projectId]/layout.tsx`);
  the page consumes each param once and strips it from the URL, then calls
  `openChat()` / `openNewEpic()` on the panel ref.

The project layout's own header is gone, and with it the old `Chat` header
button — the layout says so explicitly: two controls for one panel is the
duplication the rebuild removed.

## Canonical data sources

- Conversation list / create / rename / delete:
  `GET|POST /api/projects/:projectId/conversations`,
  `PATCH|DELETE /api/projects/:projectId/conversations/:conversationId`
  (`hooks/useConversations.ts`).
- Message history and streaming: `GET /api/projects/:projectId/chat`,
  `POST /api/projects/:projectId/chat/stream` (`hooks/useChat.ts`).
- The chat page's project scope, ticket lookups and live-agent facts come from
  the desk aggregate, `GET /api/control-desk` (`hooks/useControlDesk.ts`) — not
  from a chat-specific route.
- On the project route, live agent state is the page's own
  `hooks/useAgentPolling` → `GET /api/projects/:projectId/sessions/active`.

Neither surface carries a store or a route of its own; no right-panel-specific
pathway remains attached to any UI entry point.

## Parity contract

- Contract module: `lib/chat/parity-contract.ts`
- What it actually exports today:
  - status semantics — `LegacyConversationStatus` is `active | generating |
    generated | error`, and anything else normalizes to `active`;
  - the label rule — `resolveLegacyConversationLabel` falls back to `Chat`,
    `New Epic` or `Brainstorm` from the conversation's agent type;
  - the sort — `createdAt` ascending, ties broken by id.

  (The previous version of this document also listed a "filter contract
  (`all`)". No such export exists in the module; filtering is each surface's
  own.)

The conversations route normalizes through it
(`normalizeLegacyConversationStatus`, `sortConversationsForLegacyParity`), and
both the panel and the chat page read `isLegacyConversationGenerating` from it.

## Cutover migration

- Migration module: `lib/chat/unified-cutover-migration.ts`
- Trigger: one-time-per-project on conversation load —
  `runUnifiedChatCutoverMigrationOnce(projectId)` in the conversations route's
  `GET`. Still wired; the rebuild did not touch it.
- Behavior:
  - writes pre-migration backup snapshot
  - reassigns orphan messages to an existing/fallback conversation without
    remapping existing IDs
  - writes integrity/audit report

### Artifacts

- Base directory: `data/migrations/unified-chat-cutover/<projectId>/`
- Files per run:
  - `<timestamp>-backup.json`
  - `<timestamp>-report.json`
