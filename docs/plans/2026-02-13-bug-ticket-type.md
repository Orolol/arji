# Bug Ticket Type Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "bug" ticket type to the kanban system with modal creation, visual distinction, and detail view.

**Architecture:** Bugs live in the `epics` table with a `type` column. A new Dialog modal (not chat) handles bug creation. EpicCard and EpicDetail conditionally render bug-specific styling and fields.

**Tech Stack:** Next.js 16, Drizzle ORM, SQLite, shadcn/ui Dialog, lucide-react Bug icon, Tailwind CSS v4.

---

### Task 1: Schema Migration — Add type, linkedEpicId, images columns

**Files:**
- Modify: `lib/db/schema.ts:35-53` (epics table definition)

**Step 1: Add columns to epics table in schema.ts**

In `lib/db/schema.ts`, add 3 columns to the `epics` table after the existing `updatedAt` column:

```typescript
type: text("type").default("feature"), // 'feature' | 'bug'
linkedEpicId: text("linked_epic_id").references(() => epics.id, { onDelete: "set null" }),
images: text("images"), // JSON array of image paths
```

**Step 2: Push schema to DB**

Run: `npx drizzle-kit push`
Expected: Schema pushed successfully, existing rows get `type = 'feature'` via default.

**Step 3: Commit**

```bash
git add lib/db/schema.ts
git commit -m "feat(schema): add type, linkedEpicId, images columns to epics table"
```

---

### Task 2: Update TypeScript types — KanbanEpic and EpicDetail

**Files:**
- Modify: `lib/types/kanban.ts:33-51` (KanbanEpic interface)
- Modify: `hooks/useEpicDetail.ts:16-26` (EpicDetail interface)

**Step 1: Add type field to KanbanEpic interface**

In `lib/types/kanban.ts`, add to the `KanbanEpic` interface:

```typescript
type: string; // 'feature' | 'bug'
linkedEpicId: string | null;
images: string | null; // JSON array
```

**Step 2: Add type field to EpicDetail interface**

In `hooks/useEpicDetail.ts`, add to the `EpicDetail` interface:

```typescript
type: string;
linkedEpicId: string | null;
images: string | null;
```

**Step 3: Commit**

```bash
git add lib/types/kanban.ts hooks/useEpicDetail.ts
git commit -m "feat(types): add type, linkedEpicId, images to KanbanEpic and EpicDetail"
```

---

### Task 3: Update GET epics API to include new columns

**Files:**
- Modify: `app/api/projects/[projectId]/epics/route.ts:14-37` (GET handler select fields)

**Step 1: Add type, linkedEpicId, images to the select in GET**

In the GET handler's `.select()`, add after `updatedAt`:

```typescript
type: epics.type,
linkedEpicId: epics.linkedEpicId,
images: epics.images,
```

**Step 2: Add type to POST handler**

In the POST handler's `.values()`, add:

```typescript
type: body.type || "feature",
linkedEpicId: body.linkedEpicId || null,
images: body.images ? JSON.stringify(body.images) : null,
```

**Step 3: Verify dev server runs**

Run: `npm run dev` and visit `/api/projects/<id>/epics` to confirm new fields appear.

**Step 4: Commit**

```bash
git add app/api/projects/[projectId]/epics/route.ts
git commit -m "feat(api): include type, linkedEpicId, images in epic CRUD"
```

---

### Task 4: Create POST /api/projects/[projectId]/bugs route

**Files:**
- Create: `app/api/projects/[projectId]/bugs/route.ts`

**Step 1: Create the bug creation API route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { epics } from "@/lib/db/schema";
import { eq, sql, and } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { tryExportArjiJson } from "@/lib/sync/export";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await request.json();
  const now = new Date().toISOString();

  if (!body.title) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const maxPos = db
    .select({ max: sql<number>`COALESCE(MAX(position), -1)` })
    .from(epics)
    .where(and(eq(epics.projectId, projectId), eq(epics.status, "backlog")))
    .get();

  const id = createId();

  db.insert(epics)
    .values({
      id,
      projectId,
      title: body.title,
      description: body.description || null,
      priority: body.priority ?? 2, // bugs default to High
      status: "backlog",
      position: (maxPos?.max ?? -1) + 1,
      type: "bug",
      linkedEpicId: body.linkedEpicId || null,
      images: body.images ? JSON.stringify(body.images) : null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const bug = db.select().from(epics).where(eq(epics.id, id)).get();
  tryExportArjiJson(projectId);
  return NextResponse.json({ data: bug }, { status: 201 });
}
```

**Step 2: Commit**

```bash
git add app/api/projects/[projectId]/bugs/route.ts
git commit -m "feat(api): add POST /bugs route for direct bug creation"
```

---

### Task 5: Create BugCreateDialog component

**Files:**
- Create: `components/kanban/BugCreateDialog.tsx`

**Step 1: Create the bug creation dialog**

```tsx
"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PRIORITY_LABELS } from "@/lib/types/kanban";
import { Loader2 } from "lucide-react";

interface BugCreateDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}

export function BugCreateDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
}: BugCreateDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("2"); // default High
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/bugs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          priority: Number(priority),
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || "Failed to create bug");
      } else {
        setTitle("");
        setDescription("");
        setPriority("2");
        onOpenChange(false);
        onCreated?.();
      }
    } catch {
      setError("Failed to create bug");
    }

    setSubmitting(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>New Bug</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Title *
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Bug title..."
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Description
            </label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Steps to reproduce, expected vs actual behavior..."
              rows={4}
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Priority
            </label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PRIORITY_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!title.trim() || submitting}
            variant="destructive"
          >
            {submitting && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
            Create Bug
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Commit**

```bash
git add components/kanban/BugCreateDialog.tsx
git commit -m "feat(ui): add BugCreateDialog component for modal bug creation"
```

---

### Task 6: Add "New Bug" button to header bar

**Files:**
- Modify: `app/projects/[projectId]/page.tsx:26` (imports)
- Modify: `app/projects/[projectId]/page.tsx:195-214` (header bar)

**Step 1: Add imports**

Add to existing imports in `page.tsx`:

```typescript
import { Bug } from "lucide-react";
import { BugCreateDialog } from "@/components/kanban/BugCreateDialog";
```

**Step 2: Add state for dialog**

Inside `KanbanPage()`, add:

```typescript
const [bugDialogOpen, setBugDialogOpen] = useState(false);
```

**Step 3: Add "New Bug" button after "New Epic" button**

After the "New Epic" `<Button>` (line 213), add:

```tsx
<Button
  size="sm"
  variant="outline"
  onClick={() => setBugDialogOpen(true)}
  className="h-7 text-xs text-red-400 border-red-400/30 hover:bg-red-400/10"
>
  <Bug className="h-3 w-3 mr-1" />
  New Bug
</Button>
```

**Step 4: Add BugCreateDialog before closing `</div>`**

Before the `<EpicDetail>` component (around line 352), add:

```tsx
<BugCreateDialog
  projectId={projectId}
  open={bugDialogOpen}
  onOpenChange={setBugDialogOpen}
  onCreated={() => setRefreshTrigger((t) => t + 1)}
/>
```

**Step 5: Verify in browser**

Run dev server, navigate to a project. The "New Bug" button should appear in the header next to "New Epic" with a red tint. Clicking it should open the dialog.

**Step 6: Commit**

```bash
git add app/projects/[projectId]/page.tsx
git commit -m "feat(ui): add New Bug button to kanban header bar"
```

---

### Task 7: Visual distinction for bug cards on the board

**Files:**
- Modify: `components/kanban/EpicCard.tsx`

**Step 1: Add Bug icon import**

Add `Bug` to the lucide-react imports.

**Step 2: Add bug visual styling**

In EpicCard, detect `epic.type === "bug"` and apply:

- Add a left border accent: `border-l-2 border-l-red-500` when type is bug
- Replace the priority badge area with a "Bug" badge when type is bug

Update the `<Card>` className:

```tsx
className={`p-2 gap-0 rounded-md shadow-none cursor-pointer hover:bg-accent/50 transition-colors ${
  isOverlay ? "shadow-lg" : ""
} ${isDragging ? "shadow-md" : ""} ${
  selected ? "ring-2 ring-primary" : ""
} ${epic.type === "bug" ? "border-l-2 border-l-red-500" : ""}`}
```

After the priority badge, add a bug indicator:

```tsx
{epic.type === "bug" && (
  <Badge className="text-xs shrink-0 bg-red-500/10 text-red-400">
    <Bug className="h-3 w-3 mr-0.5" />
    Bug
  </Badge>
)}
```

**Step 3: Commit**

```bash
git add components/kanban/EpicCard.tsx
git commit -m "feat(ui): add visual distinction for bug cards on kanban board"
```

---

### Task 8: Bug-specific rendering in EpicDetail

**Files:**
- Modify: `components/kanban/EpicDetail.tsx`

**Step 1: Add Bug icon import**

Add `Bug` to the lucide-react imports.

**Step 2: Add bug badge in header**

In `EpicDetail`, after the `<SheetTitle>` InlineEdit, add a conditional bug badge:

```tsx
{epic.type === "bug" && (
  <Badge className="bg-red-500/10 text-red-400 text-xs">
    <Bug className="h-3 w-3 mr-1" />
    Bug
  </Badge>
)}
```

**Step 3: Show linked epic if present**

After the priority/status select row, add:

```tsx
{epic.type === "bug" && epic.linkedEpicId && (
  <div className="text-xs text-muted-foreground">
    Linked to epic: <span className="font-mono">{epic.linkedEpicId}</span>
  </div>
)}
```

**Step 4: Conditionally hide User Stories section for bugs**

Wrap the "User Stories" section in a condition: only show if `epic.type !== "bug"` (bugs don't have user stories by default).

**Step 5: Commit**

```bash
git add components/kanban/EpicDetail.tsx
git commit -m "feat(ui): add bug-specific rendering in EpicDetail panel"
```

---

### Task 9: End-to-end verification

**Step 1: Run dev server**

Run: `npm run dev`

**Step 2: Test bug creation flow**

1. Navigate to a project
2. Click "New Bug" button — dialog should open
3. Fill title + description, select priority
4. Click "Create Bug" — dialog closes, board refreshes
5. Bug card appears in Backlog with red left border and "Bug" badge

**Step 3: Test bug detail**

1. Click on the bug card
2. EpicDetail sheet opens with "Bug" badge, no User Stories section
3. Edit title/description inline — verify save works

**Step 4: Test drag-and-drop**

1. Drag bug card to another column — verify it moves correctly

**Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: polish bug ticket type implementation"
```
