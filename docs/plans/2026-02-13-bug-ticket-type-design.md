# Bug Ticket Type — Design

## Goal

Add a "bug" ticket type to the kanban system, with a distinct creation flow (modal, not chat), visual distinction on the board, and a dedicated detail view.

## Architecture

Bugs are stored in the existing `epics` table with a `type` column (`'feature' | 'bug'`). This reuses the full pipeline (kanban, DnD, sessions, builds) with minimal changes.

## Schema Migration

Add 3 columns to `epics`:

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `type` | TEXT | `'feature'` | `'feature'` or `'bug'` |
| `linkedEpicId` | TEXT (nullable) | NULL | Self-referencing FK to `epics.id` |
| `images` | TEXT (nullable) | NULL | JSON array of image references |

All existing rows get `type = 'feature'`.

## API Routes

### POST `/api/projects/[id]/bugs`

Direct creation. Body: `{ title, description?, priority?, images?, linkedEpicId? }`.
Inserts into `epics` with `type: 'bug'`, `status: 'backlog'`.

### POST `/api/projects/[id]/bugs/create-and-resolve`

Creates bug + immediately dispatches an agent session.
Body: `{ title, description?, priority?, images?, linkedEpicId?, provider? }`.

Existing GET/PATCH/DELETE routes on `/epics` handle both types transparently.

## UI Components

### "New Bug" Button

Location: header bar in `app/projects/[projectId]/page.tsx` (next to "New Epic").
Icon: `Bug` from lucide-react.
Visually distinct: destructive/red variant.

### Bug Creation Modal (Dialog)

Opens on click. Fields:
- Title (required, text input)
- Description (optional, textarea)
- Priority (select: low/medium/high/critical)
- Linked Epic (optional, select from project epics)
- Images (optional, file upload)

Direct API submission — no chat workflow.

### Bug Card (EpicCard variant)

- Left border: red/orange accent
- Badge: "Bug" with Bug icon
- Same DnD, selection, running indicator behavior

### Bug Detail View (EpicDetail variant)

- Reuses EpicDetail sheet layout
- Shows images gallery, linked epic link, status
- Same tabs: sessions, comments
- Inline editing for title/description
