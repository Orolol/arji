/**
 * Where a session's durable artifacts live.
 *
 * Split out of `artifacts.ts` and `servable-artifacts.ts` so both resolve the
 * root the same way, and so the one `process.cwd()` join is written with
 * literal segments. Turbopack evaluates filesystem joins statically: an
 * unscoped one makes the build assume anything under the project may be read
 * and copy every source file — and `public/` — into the server output bundle
 * ("Dynamic filesystem access causes tracing of the whole project").
 */

import path from "node:path";

/**
 * Absolute path of `data/sessions`, or of an explicit override.
 *
 * The override exists for tests, which point the whole artifact tree at a
 * temporary directory. Such a path is opaque to static analysis by
 * construction and never exists in a production build, so the trace is opted
 * out of on that branch rather than being allowed to widen to the project.
 */
export function resolveSessionsRoot(override?: string): string {
  if (override === undefined) {
    return path.join(process.cwd(), "data", "sessions");
  }

  return path.resolve(/*turbopackIgnore: true*/ override);
}
