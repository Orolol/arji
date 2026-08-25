/**
 * Learned project memory — storage helpers (lib/documents/memory.ts) against
 * the real migrated schema via createTestDb:
 *
 *   - save/read round-trip (create then replace, single row per project),
 *   - hard cap enforced by truncation on write,
 *   - getProjectMemoryContent trims and nulls empty/missing content,
 *   - the 'memory' kind never leaks into listProjectTextDocuments
 *     (prompt reference documents filter kind = 'text'), so the memory doc
 *     cannot double-inject as a reference document,
 *   - replaceProjectMemoryWithSnapshot commits the snapshot and the
 *     replacement together or not at all.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/test-utils";
import { documents, projects } from "@/lib/db/schema";
import {
  archiveProjectMemory,
  enforceMemoryCap,
  getProjectMemoryArchiveDoc,
  getProjectMemoryContent,
  getProjectMemoryDoc,
  replaceProjectMemoryWithSnapshot,
  saveProjectMemory,
} from "@/lib/documents/memory";
import {
  MEMORY_ARCHIVE_DOC_KIND,
  MEMORY_DOC_FILENAME,
  MEMORY_DOC_KIND,
  PROJECT_MEMORY_MAX_CHARS,
  isInternalMemoryDocKind,
} from "@/lib/documents/memory-constants";

type TestDb = ReturnType<typeof createTestDb>["db"];

let db: TestDb;
const PROJECT_ID = "proj-memory";

beforeEach(() => {
  db = createTestDb().db;
  db.insert(projects).values({ id: PROJECT_ID, name: "Memory Project" }).run();
});

describe("saveProjectMemory / getProjectMemoryDoc", () => {
  it("creates the memory document on first save", () => {
    const { doc, truncated } = saveProjectMemory(
      PROJECT_ID,
      "## Conventions\n\n- Use createId for ids",
      db
    );

    expect(truncated).toBe(false);
    expect(doc.kind).toBe(MEMORY_DOC_KIND);
    expect(doc.originalFilename).toBe(MEMORY_DOC_FILENAME);
    expect(doc.markdownContent).toContain("Use createId");
    expect(doc.projectId).toBe(PROJECT_ID);

    const loaded = getProjectMemoryDoc(PROJECT_ID, db);
    expect(loaded?.id).toBe(doc.id);
  });

  it("replaces content in place on subsequent saves (single row)", () => {
    const first = saveProjectMemory(PROJECT_ID, "v1", db);
    const second = saveProjectMemory(PROJECT_ID, "v2", db);

    expect(second.doc.id).toBe(first.doc.id);
    expect(second.doc.markdownContent).toBe("v2");

    const rows = db
      .select()
      .from(documents)
      .where(eq(documents.projectId, PROJECT_ID))
      .all();
    expect(rows).toHaveLength(1);
  });

  it("truncates content over the hard cap and reports it", () => {
    const oversized = "x".repeat(PROJECT_MEMORY_MAX_CHARS + 500);
    const { doc, truncated } = saveProjectMemory(PROJECT_ID, oversized, db);

    expect(truncated).toBe(true);
    expect(doc.markdownContent).toHaveLength(PROJECT_MEMORY_MAX_CHARS);
    expect(doc.sizeBytes).toBe(PROJECT_MEMORY_MAX_CHARS);
  });

  it("keeps memory docs per-project", () => {
    db.insert(projects).values({ id: "proj-other", name: "Other" }).run();
    saveProjectMemory(PROJECT_ID, "memory A", db);
    saveProjectMemory("proj-other", "memory B", db);

    expect(getProjectMemoryContent(PROJECT_ID, db)).toBe("memory A");
    expect(getProjectMemoryContent("proj-other", db)).toBe("memory B");
  });
});

describe("enforceMemoryCap", () => {
  it("is a no-op at or under the cap", () => {
    const exact = "y".repeat(PROJECT_MEMORY_MAX_CHARS);
    expect(enforceMemoryCap(exact)).toBe(exact);
    expect(enforceMemoryCap("short")).toBe("short");
  });

  it("cuts at exactly the cap", () => {
    const over = "z".repeat(PROJECT_MEMORY_MAX_CHARS + 1);
    expect(enforceMemoryCap(over)).toHaveLength(PROJECT_MEMORY_MAX_CHARS);
  });
});

describe("getProjectMemoryContent", () => {
  it("returns null when no memory document exists", () => {
    expect(getProjectMemoryContent(PROJECT_ID, db)).toBeNull();
  });

  it("returns null for whitespace-only content", () => {
    saveProjectMemory(PROJECT_ID, "   \n\n  ", db);
    expect(getProjectMemoryContent(PROJECT_ID, db)).toBeNull();
  });

  it("returns trimmed content", () => {
    saveProjectMemory(PROJECT_ID, "\n\n- rule\n\n", db);
    expect(getProjectMemoryContent(PROJECT_ID, db)).toBe("- rule");
  });
});

describe("kind discriminator isolation", () => {
  it("keeps the memory doc out of prompt reference documents (kind = 'text')", async () => {
    // listProjectTextDocuments reads the shared `db` from @/lib/db, so probe
    // the same predicate it uses directly against the test database.
    saveProjectMemory(PROJECT_ID, "durable conventions", db);
    db.insert(documents)
      .values({
        id: "doc-text",
        projectId: PROJECT_ID,
        originalFilename: "notes.md",
        kind: "text",
        markdownContent: "reference notes",
      })
      .run();

    const textRows = db
      .select()
      .from(documents)
      .where(eq(documents.kind, "text"))
      .all();
    expect(textRows.map((row) => row.originalFilename)).toEqual(["notes.md"]);

    const memoryRows = db
      .select()
      .from(documents)
      .where(eq(documents.kind, MEMORY_DOC_KIND))
      .all();
    expect(memoryRows).toHaveLength(1);
  });
});

/**
 * A dream replaces the whole memory and keeps exactly ONE snapshot of what it
 * replaced. Writing that snapshot before the replacement — as two separate
 * statements — means a save that throws leaves the archive already overwritten
 * with text that is still the live memory: the user loses their only way back,
 * in exchange for a rewrite that never happened.
 *
 * Forced honestly: the save of an existing memory row goes through UPDATE, so
 * the failure is injected there (a disk/IO error is exactly what that looks
 * like in production), while the archive INSERT on the line before succeeds.
 */
function dbWithFailingUpdate(real: TestDb): TestDb {
  const wrap = (target: TestDb): TestDb =>
    new Proxy(target, {
      get(inner, prop, receiver) {
        if (prop === "transaction") {
          return (callback: (tx: TestDb) => unknown) =>
            (inner as TestDb).transaction((tx) =>
              callback(wrap(tx as unknown as TestDb))
            );
        }
        if (prop === "update") {
          return () => {
            throw new Error("simulated disk failure");
          };
        }
        return Reflect.get(inner, prop, receiver);
      },
    }) as TestDb;
  return wrap(real);
}

/**
 * The one predicate that keeps the memory documents out of every list surface:
 * the documents GET route, the Docs page, the DELETE guard, and — the subtle
 * one — `listProjectDocuments`, which backs @mention resolution. A memory doc
 * mentionable by name would inject a second copy of text `memorySection()`
 * already puts in every prompt.
 */
describe("isInternalMemoryDocKind", () => {
  it("claims both memory kinds and nothing else", () => {
    expect(isInternalMemoryDocKind(MEMORY_DOC_KIND)).toBe(true);
    expect(isInternalMemoryDocKind(MEMORY_ARCHIVE_DOC_KIND)).toBe(true);
    expect(isInternalMemoryDocKind("text")).toBe(false);
    expect(isInternalMemoryDocKind("image")).toBe(false);
    expect(isInternalMemoryDocKind(null)).toBe(false);
    expect(isInternalMemoryDocKind(undefined)).toBe(false);
  });

  it("covers every kind the memory workflow writes", () => {
    saveProjectMemory(PROJECT_ID, "- memory", db);
    archiveProjectMemory(PROJECT_ID, "- snapshot", db);

    const written = db
      .select()
      .from(documents)
      .where(eq(documents.projectId, PROJECT_ID))
      .all();
    expect(written).toHaveLength(2);
    expect(written.every((doc) => isInternalMemoryDocKind(doc.kind))).toBe(true);
  });
});

describe("replaceProjectMemoryWithSnapshot", () => {
  it("stores the new memory and snapshots the old one", () => {
    saveProjectMemory(PROJECT_ID, "- OLD RULE", db);

    const result = replaceProjectMemoryWithSnapshot(PROJECT_ID, "- NEW RULE", db);

    expect(getProjectMemoryContent(PROJECT_ID, db)).toBe("- NEW RULE");
    expect(result.archive?.markdownContent).toBe("- OLD RULE");
    expect(getProjectMemoryArchiveDoc(PROJECT_ID, db)?.kind).toBe(
      MEMORY_ARCHIVE_DOC_KIND
    );
  });

  it("writes no snapshot when there was no memory to replace", () => {
    const result = replaceProjectMemoryWithSnapshot(PROJECT_ID, "- FIRST", db);

    expect(result.archive).toBeNull();
    expect(getProjectMemoryArchiveDoc(PROJECT_ID, db)).toBeNull();
    expect(getProjectMemoryContent(PROJECT_ID, db)).toBe("- FIRST");
  });

  it("rolls the snapshot back when the replacement fails", () => {
    saveProjectMemory(PROJECT_ID, "- ORIGINAL", db);

    expect(() =>
      replaceProjectMemoryWithSnapshot(
        PROJECT_ID,
        "- NEVER STORED",
        dbWithFailingUpdate(db)
      )
    ).toThrow("simulated disk failure");

    // Nothing moved: no half-written archive, memory untouched.
    expect(getProjectMemoryArchiveDoc(PROJECT_ID, db)).toBeNull();
    expect(getProjectMemoryContent(PROJECT_ID, db)).toBe("- ORIGINAL");
  });

  it("keeps the PREVIOUS snapshot intact when a later replacement fails", () => {
    saveProjectMemory(PROJECT_ID, "- FIRST MEMORY", db);
    replaceProjectMemoryWithSnapshot(PROJECT_ID, "- SECOND MEMORY", db);
    expect(getProjectMemoryArchiveDoc(PROJECT_ID, db)?.markdownContent).toBe(
      "- FIRST MEMORY"
    );

    expect(() =>
      replaceProjectMemoryWithSnapshot(
        PROJECT_ID,
        "- THIRD MEMORY",
        dbWithFailingUpdate(db)
      )
    ).toThrow();

    // The snapshot still holds the memory the user might want back — NOT the
    // live text a two-statement version would have overwritten it with.
    expect(getProjectMemoryArchiveDoc(PROJECT_ID, db)?.markdownContent).toBe(
      "- FIRST MEMORY"
    );
    expect(getProjectMemoryContent(PROJECT_ID, db)).toBe("- SECOND MEMORY");
  });
});

describe("archiveProjectMemory", () => {
  it("keeps exactly one snapshot row per project", () => {
    archiveProjectMemory(PROJECT_ID, "- v1", db);
    archiveProjectMemory(PROJECT_ID, "- v2", db);

    const archives = db
      .select()
      .from(documents)
      .where(eq(documents.projectId, PROJECT_ID))
      .all()
      .filter((doc) => doc.kind === MEMORY_ARCHIVE_DOC_KIND);
    expect(archives).toHaveLength(1);
    expect(archives[0].markdownContent).toBe("- v2");
  });

  it("is a no-op for empty content, so a real snapshot is never hidden", () => {
    archiveProjectMemory(PROJECT_ID, "- real snapshot", db);
    expect(archiveProjectMemory(PROJECT_ID, "   ", db)).toBeNull();
    expect(archiveProjectMemory(PROJECT_ID, null, db)).toBeNull();
    expect(getProjectMemoryArchiveDoc(PROJECT_ID, db)?.markdownContent).toBe(
      "- real snapshot"
    );
  });
});
