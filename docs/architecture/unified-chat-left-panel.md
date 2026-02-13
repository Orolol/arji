# Unified Chat Left Panel Cutover

## Scope
- The project now supports a single chat workspace: `components/chat/UnifiedChatPanel.tsx`.
- The legacy right-side chat entry and panel were removed from `app/projects/[projectId]/layout.tsx`.
- No legacy deep-link redirect behavior is implemented.

## Entry Points
- `Chat` button in `app/projects/[projectId]/page.tsx` opens unified chat (`openChat()`).
- `New Epic` button in `app/projects/[projectId]/page.tsx` opens unified chat and creates an `epic_creation` conversation (`openNewEpic()`).
- Both entry points land in the same left workspace component state.

## Canonical Data Sources
- Conversation list: `GET /api/projects/[projectId]/conversations`
- Message history and streaming: `GET /api/projects/[projectId]/chat`, `POST /api/projects/[projectId]/chat/stream`
- Active activity/session monitoring: `GET /api/projects/[projectId]/sessions/active`

The unified panel reads/writes these canonical pathways only. No right-panel-specific store or route remains attached to UI entry points.

## Parity Contract
- Contract module: `lib/chat/parity-contract.ts`
- Defines:
  - tab taxonomy (`brainstorm`, `epic_creation`)
  - status semantics (`active`, `generating`, `generated`, `error`)
  - filter contract (`all`)
  - sorting contract (`created_at_asc`)

Both conversation route normalization and unified panel rendering use this contract.

## Cutover Migration
- Migration module: `lib/chat/unified-cutover-migration.ts`
- Trigger: one-time-per-project on conversation load (`runUnifiedChatCutoverMigrationOnce` in conversations route)
- Behavior:
  - writes pre-migration backup snapshot
  - reassigns orphan messages to an existing/fallback conversation without remapping existing IDs
  - writes integrity/audit report

### Artifacts
- Base directory: `data/migrations/unified-chat-cutover/<projectId>/`
- Files per run:
  - `<timestamp>-backup.json`
  - `<timestamp>-report.json`
