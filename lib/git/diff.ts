import simpleGit from "simple-git";

/**
 * A single hunk within a file diff, representing a contiguous
 * region of changed lines.
 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "del" | "context";
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface FileDiff {
  filePath: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  hunks: DiffHunk[];
}

export interface DiffMetadata {
  branchName: string;
  baseBranch: string;
  ahead: number;
  behind: number;
  hasUncommittedChanges: boolean;
  mergeBaseCommit: string | null;
}

export interface DiffResult {
  files: FileDiff[];
  metadata: DiffMetadata;
}

/**
 * Generates a structured diff between an epic's worktree branch and
 * the main branch (or a specified base), including metadata about
 * branch divergence and uncommitted changes.
 */
export async function getWorktreeDiff(
  worktreePath: string,
  baseBranch = "main"
): Promise<DiffResult> {
  if (baseBranch.startsWith("-")) {
    throw new Error(`Invalid base branch: ${baseBranch}`);
  }
  const git = simpleGit(worktreePath);

  // Get current branch name
  const branchName = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();

  // Find the merge base so we only see the epic's changes
  let mergeBase: string | null = null;
  try {
    // Invariant: `--` separator ensures baseBranch cannot be parsed as an option.
    mergeBase = (await git.raw(["merge-base", "--", baseBranch, "HEAD"])).trim();
  } catch {
    // merge-base fails for unrelated histories or missing branches
  }
  // Compute ahead/behind counts
  let ahead = 0;
  let behind = 0;
  try {
    const revList = (
      await git.raw([
        "rev-list",
        "--left-right",
        "--count",
        `${baseBranch}...HEAD`,
      ])
    ).trim();
    const parts = revList.split(/\s+/);
    behind = parseInt(parts[0], 10) || 0;
    ahead = parseInt(parts[1], 10) || 0;
  } catch {
    // If rev-list fails, counts stay at 0
  }

  // Check for uncommitted changes (staged + unstaged)
  let hasUncommittedChanges = false;
  try {
    const status = await git.status();
    hasUncommittedChanges =
      status.modified.length > 0 ||
      status.not_added.length > 0 ||
      status.staged.length > 0 ||
      status.deleted.length > 0 ||
      status.renamed.length > 0 ||
      status.created.length > 0;
  } catch {
    // Ignore status errors
  }

  // Get the committed diff from merge-base
  let files: FileDiff[] = [];
  if (mergeBase) {
    const rawDiff = await git.diff([mergeBase, "HEAD", "-U3"]);
    files = parseUnifiedDiff(rawDiff);
  }

  // If committed diff is empty but branch is ahead, try direct diff
  // This handles the case where merge-base == HEAD (branch not diverged)
  if (files.length === 0 && ahead === 0 && mergeBase) {
    // The branch hasn't diverged from base — try showing uncommitted changes
    try {
      const uncommittedDiff = await git.diff(["-U3"]);
      const stagedDiff = await git.diff(["--cached", "-U3"]);
      const combined = [uncommittedDiff, stagedDiff].filter(Boolean).join("\n");
      if (combined.trim()) {
        files = parseUnifiedDiff(combined);
      }
    } catch {
      // Ignore diff errors
    }
  }

  return {
    files,
    metadata: {
      branchName,
      baseBranch,
      ahead,
      behind,
      hasUncommittedChanges,
      mergeBaseCommit: mergeBase,
    },
  };
}

/**
 * Parses a unified diff string into structured FileDiff objects.
 */
export function parseUnifiedDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  if (!raw.trim()) return files;

  const lines = raw.split("\n");
  let currentFile: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New file header: diff --git a/path b/path
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      currentHunk = null;

      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (!match) continue;

      const aPath = match[1];
      const bPath = match[2];

      currentFile = {
        filePath: bPath,
        status: "modified",
        hunks: [],
      };

      if (aPath !== bPath) {
        currentFile.status = "renamed";
        currentFile.oldPath = aPath;
      }

      files.push(currentFile);
      continue;
    }

    if (!currentFile) continue;

    // Detect added/deleted files
    if (line.startsWith("new file mode")) {
      currentFile.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      currentFile.status = "deleted";
      continue;
    }

    // Skip index / --- / +++ headers
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("Binary files")
    ) {
      continue;
    }

    // Hunk header: @@ -old,count +new,count @@
    const hunkMatch = line.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
    );
    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldLines = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newLines = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;

      currentHunk = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    if (!currentHunk) continue;

    // Skip "\ No newline at end of file" marker
    if (line.startsWith("\\")) continue;

    // Diff lines
    if (line.startsWith("+")) {
      currentHunk.lines.push({
        type: "add",
        content: line.slice(1),
        oldLineNumber: null,
        newLineNumber: newLine,
      });
      newLine++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({
        type: "del",
        content: line.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: null,
      });
      oldLine++;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({
        type: "context",
        content: line.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine++;
      newLine++;
    }
    // Empty lines between hunks/files are ignored
  }

  return files;
}
