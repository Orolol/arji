/**
 * Prose → structured findings, for review sessions whose MCP channel never
 * lands a `submit_findings` call.
 *
 * WHY THIS EXISTS. The review verdict is supposed to ride the structured
 * channel: `submit_findings` writes reviewComments rows, and everything
 * downstream reads them — collectBlockingFindings computes the verdict,
 * buildReviewFeedbackSection puts the open rows in the next builder's prompt,
 * and get_ticket exposes them to any agent that asks. That chain is correct
 * and fully wired. It was simply never fed: reviewComments held ZERO rows for
 * the entire life of the database, so every review fell through to the prose
 * substring fallback ('changes requested' → blocking) and every builder was
 * dispatched with no idea what the reviewer had actually found. Reviewers
 * then re-scanned the whole epic each cycle and reported a fresh set of
 * Majors, which is how epic E-arij-096 burned 25 build sessions and ~$79
 * across four review cycles without converging.
 *
 * The direct cause is provider-side: codex-cli 0.148 does not start
 * user-configured `mcp_servers` under `codex exec` at all — neither via the
 * `-c mcp_servers.*` overrides Arij injects nor via a persisted
 * ~/.codex/config.toml entry, in any sandbox mode. The exec tool catalog
 * carries only codex's own `codex_apps` tools. See lib/providers/codex.ts.
 *
 * Rather than make structured findings hostage to one CLI's MCP support,
 * this module recovers them from the report the reviewer already writes. The
 * built-in review prompts mandate a rigid shape (prompt-builder.ts
 * REVIEW_CHECKLISTS + the Instructions block), and every provider observed in
 * this repo — codex, claude-code, oh-my-pi, pi — emits it:
 *
 *   ### 3. Les captures de bug ne sont jamais supprimées
 *
 *   - **Severity:** Major
 *   - **Location:** [app/api/projects/[projectId]/bugs/route.ts:51](/abs/…:51)
 *   - **Description:** …
 *   - **Recommendation:** …
 *
 * A block is treated as a finding IFF it declares a severity — that single
 * discriminator is what keeps checklist sections, verification notes and the
 * summary out of the results, without hardcoding heading numbering.
 *
 * Deliberately tolerant, never throwing: a report that parses to nothing
 * leaves the caller on the prose fallback it already had, so a reviewer that
 * invents its own layout degrades to today's behavior instead of breaking
 * the run.
 */

/** Severity vocabulary shared with app/api/mcp/submit-findings/route.ts. */
export type FindingSeverity = "critical" | "major" | "minor" | "info";

export interface ParsedFinding {
  /** Repo-relative where possible; whatever the reviewer wrote otherwise. */
  filePath: string;
  lineNumber: number;
  severity: FindingSeverity;
  /** Title + description + recommendation, WITHOUT the `[severity] ` prefix. */
  body: string;
}

/** Mirrors the submit-findings zod cap so both channels store alike. */
const MAX_BODY_LENGTH = 2000;

/** Reviewers write "Suggestion" for what the schema calls "info". */
const SEVERITY_ALIASES = new Map<string, FindingSeverity>([
  ["critical", "critical"],
  ["blocker", "critical"],
  ["major", "major"],
  ["minor", "minor"],
  ["info", "info"],
  ["suggestion", "info"],
  ["nit", "info"],
]);

/** `- **Severity:** Major` / `**severity**: major` / `Severity: Major`. */
const SEVERITY_LINE_RE = /^\s*[-*]?\s*\**severity\**\s*:?\**\s*:?\s*(.+?)\s*$/i;

/** Same shape for the location row. */
const LOCATION_LINE_RE = /^\s*[-*]?\s*\**location\**\s*:?\**\s*:?\s*(.+?)\s*$/i;

/** Any ATX heading — the block separator. */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Leading list/ordinal decoration on a finding title ("3. ", "- "). */
const TITLE_DECORATION_RE = /^\s*(?:[-*]\s*)?(?:\d+[.)]\s*)?/;

function normalizeSeverity(raw: string): FindingSeverity | null {
  // Strip markdown emphasis and trailing prose ("Major — blocks release").
  const cleaned = raw
    .replace(/[*_`]/g, "")
    .split(/[\s—–-]+/)[0]
    .trim()
    .toLowerCase();
  return SEVERITY_ALIASES.get(cleaned) ?? null;
}

/**
 * Pulls `path:line` out of a Location value.
 *
 * Handles the two forms observed in real reports:
 *   `[rel/path.ts:92](/abs/path.ts:92)`  — markdown link
 *   `` `rel/path.ts:58` ``               — inline code
 *
 * The link label is preferred because it is already repo-relative, and it is
 * extracted by slicing to the LAST `](` rather than by a bracket-matching
 * regex: real paths contain brackets themselves
 * (`app/api/projects/[projectId]/bugs/route.ts`), which defeats the naive
 * `\[([^\]]+)\]` and would truncate the path at `[projectId`.
 */
export function parseLocation(
  raw: string
): { filePath: string; lineNumber: number } | null {
  let value = raw.trim();

  const linkSplit = value.lastIndexOf("](");
  if (value.startsWith("[") && linkSplit > 0) {
    const label = value.slice(1, linkSplit).trim();
    const fromLabel = splitPathAndLine(label);
    if (fromLabel) return fromLabel;
    // Label carried no line number — fall back to the URL half.
    const closing = value.lastIndexOf(")");
    if (closing > linkSplit) {
      value = value.slice(linkSplit + 2, closing).trim();
    }
  }

  return splitPathAndLine(value);
}

function splitPathAndLine(
  raw: string
): { filePath: string; lineNumber: number } | null {
  const value = raw.trim().replace(/^`+|`+$/g, "").trim();
  // Anchored at the end so a path like `foo:bar/baz.ts:12` keeps its colon.
  const match = /^(.*\S)\s*:\s*(\d+)\s*$/.exec(value);
  if (!match) return null;

  const lineNumber = Number.parseInt(match[2], 10);
  // submit-findings requires line >= 1; a 0 or unparsable line is unusable.
  if (!Number.isFinite(lineNumber) || lineNumber < 1) return null;

  const filePath = normalizeFilePath(match[1]);
  if (!filePath) return null;

  return { filePath, lineNumber };
}

/**
 * Best-effort repo-relative path.
 *
 * Review sessions run in a per-ticket worktree, so absolute locations are
 * prefixed with that worktree's path. Anchoring on the worktree root name
 * would hardcode lib/git's layout here; instead the first path segment that
 * looks like a repo root directory wins. Nothing is verified against disk —
 * this module never touches the filesystem — so an unrecognized absolute path
 * is stored as-is rather than mangled.
 */
function normalizeFilePath(raw: string): string {
  const value = raw.trim().replace(/^`+|`+$/g, "").trim();
  if (!value) return "";
  if (!value.startsWith("/")) return value.replace(/^\.\//, "");

  // Absolute: keep everything from the last plausible source root onward.
  const segments = value.split("/");
  const rootIndex = segments.findIndex((segment) =>
    SOURCE_ROOT_SEGMENTS.has(segment)
  );
  if (rootIndex > 0) return segments.slice(rootIndex).join("/");

  return value;
}

/**
 * Top-level directories of this repo (CLAUDE.md "File Structure", plus the
 * test/e2e roots). Used only to re-relativize absolute worktree paths.
 */
const SOURCE_ROOT_SEGMENTS = new Set([
  "app",
  "components",
  "lib",
  "hooks",
  "bin",
  "e2e",
  "__tests__",
  "docs",
  "public",
]);

interface Block {
  title: string;
  lines: string[];
}

/** Splits the report into heading-delimited blocks (prologue dropped). */
function splitIntoBlocks(report: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;

  for (const line of report.split(/\r?\n/)) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      if (current) blocks.push(current);
      current = { title: heading[2].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);

  return blocks;
}

/**
 * Everything in the block that is not the Severity/Location metadata, folded
 * into one paragraph. Label prefixes ("**Description:**") are kept — they
 * read well in the builder prompt and in the ticket UI.
 */
function buildBody(title: string, lines: string[]): string {
  const kept = lines.filter(
    (line) => !SEVERITY_LINE_RE.test(line) && !LOCATION_LINE_RE.test(line)
  );

  const detail = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const body = detail ? `${title}\n\n${detail}` : title;
  return body.length > MAX_BODY_LENGTH
    ? `${body.slice(0, MAX_BODY_LENGTH - 1).trimEnd()}…`
    : body;
}

/**
 * Findings recovered from a review report, in document order.
 *
 * A block yields a finding only when it declares BOTH a recognized severity
 * and a `path:line` location — the same two fields submit_findings requires,
 * so prose-recovered rows are indistinguishable from tool-filed ones
 * downstream. A severity-bearing block with no usable location is skipped
 * rather than anchored at a guessed line.
 */
export function parseReviewReport(report: string): ParsedFinding[] {
  if (!report || !report.trim()) return [];

  const findings: ParsedFinding[] = [];

  for (const block of splitIntoBlocks(report)) {
    let severity: FindingSeverity | null = null;
    let location: { filePath: string; lineNumber: number } | null = null;

    for (const line of block.lines) {
      if (!severity) {
        const severityMatch = SEVERITY_LINE_RE.exec(line);
        if (severityMatch) severity = normalizeSeverity(severityMatch[1]);
      }
      if (!location) {
        const locationMatch = LOCATION_LINE_RE.exec(line);
        if (locationMatch) location = parseLocation(locationMatch[1]);
      }
    }

    if (!severity || !location) continue;

    findings.push({
      filePath: location.filePath,
      lineNumber: location.lineNumber,
      severity,
      body: buildBody(block.title.replace(TITLE_DECORATION_RE, ""), block.lines),
    });
  }

  return findings;
}
