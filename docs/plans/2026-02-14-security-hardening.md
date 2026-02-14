# Security Hardening & Input Validation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add path validation, Zod-based request validation, and localhost-only middleware to harden the Arij API.

**Architecture:** Three independent layers — (1) path validation utility for filesystem paths, (2) Zod schemas + validateBody helper for all POST/PATCH routes, (3) Next.js middleware restricting API access to localhost. Each layer is independently testable and deployable.

**Tech Stack:** Zod (new dependency), Next.js middleware, Node.js fs/path

---

### Task 1: Install Zod

**Files:**
- Modify: `package.json`

**Step 1: Install zod**

Run: `npm install zod`

**Step 2: Verify installation**

Run: `node -e "const z = require('zod'); console.log('zod', z.z ? 'OK' : 'FAIL')"`
Expected: `zod OK`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add zod dependency for request validation"
```

---

### Task 2: Path Validation Utility

**Files:**
- Create: `lib/validation/path.ts`
- Create: `lib/validation/__tests__/path.test.ts`

**Step 1: Write the failing tests**

File: `lib/validation/__tests__/path.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { validatePath } from "../path";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises");

describe("validatePath", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a valid absolute directory path", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
    const result = await validatePath("/home/user/project");
    expect(result.valid).toBe(true);
    expect(result.normalizedPath).toBe("/home/user/project");
  });

  it("normalizes relative path components", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
    const result = await validatePath("/home/user/./project");
    expect(result.valid).toBe(true);
    expect(result.normalizedPath).toBe("/home/user/project");
  });

  it("rejects path with traversal (..) after normalization", async () => {
    const result = await validatePath("/home/user/../../etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("traversal");
  });

  it("rejects empty string", async () => {
    const result = await validatePath("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("required");
  });

  it("rejects non-existent path", async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error("ENOENT"));
    const result = await validatePath("/nonexistent/path");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("does not exist");
  });

  it("rejects path that is a file, not a directory", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);
    const result = await validatePath("/home/user/file.txt");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not a directory");
  });

  it("rejects null bytes in path", async () => {
    const result = await validatePath("/home/user/\0malicious");
    expect(result.valid).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/validation/__tests__/path.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

File: `lib/validation/path.ts`

```typescript
import { stat } from "node:fs/promises";
import { resolve, normalize } from "node:path";

type PathValidationResult =
  | { valid: true; normalizedPath: string }
  | { valid: false; error: string };

export async function validatePath(inputPath: string): Promise<PathValidationResult> {
  if (!inputPath || inputPath.trim().length === 0) {
    return { valid: false, error: "Path is required" };
  }

  // Reject null bytes
  if (inputPath.includes("\0")) {
    return { valid: false, error: "Path contains invalid characters" };
  }

  const normalized = resolve(normalize(inputPath));

  // Defense in depth: reject if normalized path still resolves above root-ish
  // (resolve() already handles .., but we reject if the input *intended* traversal)
  if (inputPath.includes("..")) {
    return { valid: false, error: "Path must not contain traversal components (..)" };
  }

  try {
    const stats = await stat(normalized);
    if (!stats.isDirectory()) {
      return { valid: false, error: "Path is not a directory" };
    }
  } catch {
    return { valid: false, error: "Path does not exist or is not accessible" };
  }

  return { valid: true, normalizedPath: normalized };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/validation/__tests__/path.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add lib/validation/path.ts lib/validation/__tests__/path.test.ts
git commit -m "feat(security): add path validation utility with traversal protection"
```

---

### Task 3: Zod Schemas & validateBody Helper

**Files:**
- Create: `lib/validation/schemas.ts`
- Create: `lib/validation/validate.ts`
- Create: `lib/validation/__tests__/schemas.test.ts`
- Create: `lib/validation/__tests__/validate.test.ts`

**Step 1: Write the schema tests**

File: `lib/validation/__tests__/schemas.test.ts`

Tests for each schema: createProjectSchema, updateProjectSchema, createEpicSchema, updateEpicSchema, createStorySchema, updateStorySchema — each with valid and invalid payloads. Test that required fields cause errors when missing and optional fields pass when omitted.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/validation/__tests__/schemas.test.ts`

**Step 3: Write schemas**

File: `lib/validation/schemas.ts`

Define Zod schemas matching the DB schema fields. Key schemas:
- `createProjectSchema`: name required string (1-200 chars), description/gitRepoPath/githubOwnerRepo optional
- `updateProjectSchema`: all optional (name, description, gitRepoPath, githubOwnerRepo, status, spec)
- `createEpicSchema`: title required (3-200 chars), description/priority/status/type/branchName/confidence/evidence/linkedEpicId/images/userStories/dependencies optional
- `updateEpicSchema`: all optional (title, description, priority, status, position, branchName)
- `createStorySchema`: epicId + title required, description/acceptanceCriteria/status optional
- `updateStorySchema`: all optional (title, description, acceptanceCriteria, status, position)

**Step 4: Write the validateBody helper tests**

File: `lib/validation/__tests__/validate.test.ts`

Test that validateBody returns `{ data }` for valid body and returns a NextResponse with 400 status for invalid body.

**Step 5: Write the validateBody helper**

File: `lib/validation/validate.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { ZodSchema, ZodError } from "zod";

export async function validateBody<T>(
  schema: ZodSchema<T>,
  request: NextRequest
): Promise<{ data: T } | NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: result.error.flatten().fieldErrors,
      },
      { status: 400 }
    );
  }

  return { data: result.data };
}
```

**Step 6: Run all validation tests**

Run: `npx vitest run lib/validation/__tests__/`
Expected: All PASS

**Step 7: Commit**

```bash
git add lib/validation/schemas.ts lib/validation/validate.ts lib/validation/__tests__/schemas.test.ts lib/validation/__tests__/validate.test.ts
git commit -m "feat(security): add Zod schemas and validateBody helper for API validation"
```

---

### Task 4: Apply Path Validation to Routes

**Files:**
- Modify: `app/api/projects/route.ts` (POST)
- Modify: `app/api/projects/[projectId]/route.ts` (PATCH)
- Modify: `app/api/projects/import/route.ts` (POST)

**Step 1: Update POST /api/projects**

Add path validation for gitRepoPath when provided. Use validatePath() and return 400 if invalid. Use the normalized path for DB insertion.

**Step 2: Update PATCH /api/projects/[projectId]**

Same pattern: validate gitRepoPath when body.gitRepoPath is provided.

**Step 3: Update POST /api/projects/import**

Validate body.path with validatePath() before using it as cwd.

**Step 4: Run existing tests**

Run: `npx vitest run`
Expected: All existing tests still pass

**Step 5: Commit**

```bash
git add app/api/projects/route.ts app/api/projects/[projectId]/route.ts app/api/projects/import/route.ts
git commit -m "feat(security): validate gitRepoPath in project routes to prevent path injection"
```

---

### Task 5: Apply Zod Validation to Project Routes

**Files:**
- Modify: `app/api/projects/route.ts` (POST — replace manual check with Zod)
- Modify: `app/api/projects/[projectId]/route.ts` (PATCH — add schema)

**Step 1: Integrate validateBody into POST /api/projects**

Replace the manual `if (!name)` check with `validateBody(createProjectSchema, request)`. Handle the response union.

**Step 2: Integrate validateBody into PATCH /api/projects/[projectId]**

Add `validateBody(updateProjectSchema, request)` at the top.

**Step 3: Run tests**

Run: `npx vitest run`

**Step 4: Commit**

```bash
git add app/api/projects/route.ts app/api/projects/[projectId]/route.ts
git commit -m "feat(security): apply Zod validation to project POST and PATCH routes"
```

---

### Task 6: Apply Zod Validation to Epic & Story Routes

**Files:**
- Modify: `app/api/projects/[projectId]/epics/route.ts` (POST)
- Modify: `app/api/projects/[projectId]/epics/[epicId]/route.ts` (PATCH)
- Modify: `app/api/projects/[projectId]/user-stories/route.ts` (POST, PATCH)
- Modify: `app/api/projects/[projectId]/stories/[storyId]/route.ts` (PATCH)

**Step 1: Update epics POST**

Replace manual `if (!body.title)` with `validateBody(createEpicSchema, request)`. Use `data.title`, `data.description`, etc.

**Step 2: Update epics PATCH**

Add `validateBody(updateEpicSchema, request)`.

**Step 3: Update user-stories POST and PATCH**

Replace manual checks with `validateBody(createStorySchema, request)` and schema validation.

**Step 4: Update stories/[storyId] PATCH**

Add `validateBody(updateStorySchema, request)`.

**Step 5: Run tests**

Run: `npx vitest run`

**Step 6: Commit**

```bash
git add app/api/projects/[projectId]/epics/route.ts app/api/projects/[projectId]/epics/[epicId]/route.ts app/api/projects/[projectId]/user-stories/route.ts app/api/projects/[projectId]/stories/[storyId]/route.ts
git commit -m "feat(security): apply Zod validation to epic and story routes"
```

---

### Task 7: Localhost Middleware

**Files:**
- Create: `middleware.ts`
- Create: `lib/validation/__tests__/middleware.test.ts`

**Step 1: Write the middleware tests**

Test cases:
- localhost:3000 in host header → passes
- 127.0.0.1:3000 → passes
- [::1]:3000 → passes
- external host → 403
- missing host → 403
- origin header mismatch → 403
- matching origin → passes
- ALLOWED_ORIGINS env var override → passes
- Non-API routes are not affected

**Step 2: Run tests to verify they fail**

**Step 3: Write the middleware**

File: `middleware.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function isLocalHost(headerValue: string | null): boolean {
  if (!headerValue) return false;
  const host = headerValue.split(":")[0];
  return LOCAL_HOSTS.includes(host);
}

export function middleware(request: NextRequest) {
  const host = request.headers.get("host");
  if (!isLocalHost(host)) {
    // Check ALLOWED_ORIGINS env var
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map(s => s.trim()) ?? [];
    const origin = request.headers.get("origin");
    if (!origin || !allowedOrigins.includes(origin)) {
      return NextResponse.json(
        { error: "Forbidden: non-local request" },
        { status: 403 }
      );
    }
  }

  // If origin header is present, verify it's also local
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const originHost = new URL(origin).hostname;
      const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map(s => s.trim()) ?? [];
      if (!LOCAL_HOSTS.includes(originHost) && !allowedOrigins.includes(origin)) {
        return NextResponse.json(
          { error: "Forbidden: non-local origin" },
          { status: 403 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: "Forbidden: invalid origin" },
        { status: 403 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
```

**Step 4: Run tests**

Run: `npx vitest run lib/validation/__tests__/middleware.test.ts`

**Step 5: Commit**

```bash
git add middleware.ts lib/validation/__tests__/middleware.test.ts
git commit -m "feat(security): add localhost-only middleware for API routes"
```

---

### Task 8: Final Verification

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 2: Run the dev server and smoke test**

Run: `npm run dev` — verify the app loads and API routes respond normally from localhost.

**Step 3: Run lint**

Run: `npm run lint`

**Step 4: Final commit with any fixes**

```bash
git add -A
git commit -m "chore: final cleanup for security hardening"
```
