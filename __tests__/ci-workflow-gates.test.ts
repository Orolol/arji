/**
 * `npm test` being green proves nothing about `npm run build`.
 *
 * That is not a hypothetical: `lib/providers/pi.ts` called `this.extractResult`
 * with three arguments against a one-parameter override, and the whole unit
 * suite stayed green while `next build` exited 1 on `TS2554`. Argument lists are
 * erased at runtime, so no amount of Vitest could have seen it. `.github/
 * workflows/ci.yml` ran only `npm ci` -> `npm audit` -> `npm test`, so the break
 * reached main unopposed.
 *
 * The gates that close that hole live in a YAML file, which nothing else in this
 * repository executes or type-checks. Deleting a step, adding
 * `continue-on-error: true`, or appending `|| true` to a `run:` is a silent,
 * reviewable-in-one-line way to put the hole back. This file is the regression
 * test for the workflow itself: it reads `ci.yml` and fails when a gate stops
 * being a gate.
 *
 * Two design notes:
 *
 * - The YAML is read with a purpose-built extractor rather than `js-yaml`.
 *   `js-yaml` is present in `node_modules`, but only as a transitive dependency
 *   of eslint and cosmiconfig. Hanging a CI gate off another package's
 *   dependency tree is exactly the kind of silent decay this file exists to
 *   catch, and `__tests__/lockfile-install-consistency.test.ts` only guards
 *   *direct* dependencies.
 * - The extractor is exercised against synthetic weakened workflows as well as
 *   the real file. A test that only asserts "the real file is fine" cannot
 *   distinguish a healthy workflow from a broken parser that finds no problems
 *   anywhere; the fixtures below make the assertions prove their own teeth.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = join(process.cwd(), ".github", "workflows", "ci.yml");
const workflowSource = readFileSync(WORKFLOW_PATH, "utf-8");

interface WorkflowStep {
  job: string;
  name: string | null;
  run: string | null;
  env: Record<string, string>;
  continueOnError: string | null;
  ifCondition: string | null;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim() === "";
const isComment = (line: string): boolean => line.trimStart().startsWith("#");

/**
 * Collects the lines belonging to a block opened at `startIndex`, i.e. every
 * following line indented deeper than `ownerIndent`. Blank lines belong to the
 * block: a blank line between two steps must not terminate it.
 */
function blockBody(lines: string[], startIndex: number, ownerIndent: number): string[] {
  const body: string[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) {
      body.push(line);
      continue;
    }
    if (indentOf(line) <= ownerIndent) break;
    body.push(line);
  }
  return body;
}

/**
 * Parses the `key: value` pairs of a single step. Handles the three shapes this
 * workflow uses: plain scalars, block scalars (`run: |`), and a nested map
 * (`env:`). Anything else is ignored rather than guessed at — the assertions
 * below only ever ask about keys that are parsed here.
 */
function parseStep(job: string, stepLines: string[]): WorkflowStep {
  // `      - name: Foo` is the same mapping as `        name: Foo`; rewriting the
  // dash away lets one loop handle the first key and the rest alike.
  const normalised = stepLines.map((line, index) =>
    index === 0 ? line.replace(/^(\s*)-\s/, "$1  ") : line,
  );
  const keyIndent = indentOf(normalised[0]);

  const step: WorkflowStep = {
    job,
    name: null,
    run: null,
    env: {},
    continueOnError: null,
    ifCondition: null,
  };

  for (let i = 0; i < normalised.length; i++) {
    const line = normalised[i];
    if (isBlank(line) || isComment(line) || indentOf(line) !== keyIndent) continue;

    const match = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim();

    if (key === "env") {
      for (const envLine of blockBody(normalised, i + 1, keyIndent)) {
        if (isBlank(envLine) || isComment(envLine)) continue;
        const envMatch = /^\s*([A-Za-z0-9_]+):\s*(.*)$/.exec(envLine);
        if (envMatch) step.env[envMatch[1]] = envMatch[2].trim().replace(/^["']|["']$/g, "");
      }
      continue;
    }

    // A block scalar's content is the deeper-indented lines that follow it.
    const resolved =
      value === "|" || value === ">" || value === "|-" || value === ">-"
        ? blockBody(normalised, i + 1, keyIndent)
            .filter((body) => !isBlank(body))
            .map((body) => body.trim())
            .join("\n")
        : value;

    if (key === "run") step.run = resolved;
    else if (key === "name") step.name = resolved;
    else if (key === "continue-on-error") step.continueOnError = resolved;
    else if (key === "if") step.ifCondition = resolved;
  }

  return step;
}

/** Every `steps:` entry of every job, flattened, tagged with its job id. */
function parseSteps(source: string): WorkflowStep[] {
  const lines = source.split("\n");
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsIndex === -1) return [];

  const steps: WorkflowStep[] = [];
  const jobsBody = blockBody(lines, jobsIndex + 1, 0);

  for (let i = 0; i < jobsBody.length; i++) {
    const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(jobsBody[i]);
    if (!jobMatch) continue;

    const jobBody = blockBody(jobsBody, i + 1, 2);
    const stepsIndex = jobBody.findIndex((line) => /^ {4}steps:\s*$/.test(line));
    if (stepsIndex === -1) continue;

    // Split the steps list on its `- ` markers, then hand each slice off whole.
    const stepsBody = blockBody(jobBody, stepsIndex + 1, 4);
    let current: string[] | null = null;
    for (const line of stepsBody) {
      if (/^\s*-\s/.test(line)) {
        if (current) steps.push(parseStep(jobMatch[1], current));
        current = [line];
      } else if (current) {
        current.push(line);
      }
    }
    if (current) steps.push(parseStep(jobMatch[1], current));
  }

  return steps;
}

/**
 * The three commands the project treats as verification but CI did not run.
 * `npm run lint` is anchored so it does not match `npm run lint:prune`, which
 * appears inside the workflow's failure-explanation echo.
 */
const GATES = [
  { label: "type check (`npx tsc --noEmit`)", pattern: /(?:^|\s)(?:npx\s+)?tsc\s+--noEmit(?:\s|$)/ },
  { label: "lint (`npm run lint`)", pattern: /(?:^|\s)npm\s+run\s+lint(?:\s|$)/ },
  { label: "build (`npm run build`)", pattern: /(?:^|\s)npm\s+run\s+build(?:\s|$)/ },
] as const;

/** `cmd || true`, `cmd; true`, `set +e` — a step that runs but cannot fail. */
const SWALLOWS_FAILURE = /\|\|\s*(?:true|:)\b|;\s*true\b|(?:^|\s)set\s+\+e\b/;

const stepsRunning = (steps: WorkflowStep[], pattern: RegExp): WorkflowStep[] =>
  steps.filter((step) => step.run !== null && pattern.test(step.run));

/**
 * The single place that decides whether a workflow is acceptable, so the real
 * file and the synthetic fixtures are judged by identical rules.
 */
function gateViolations(source: string): string[] {
  const steps = parseSteps(source);
  const problems: string[] = [];

  for (const gate of GATES) {
    const matching = stepsRunning(steps, gate.pattern);
    if (matching.length === 0) {
      problems.push(`missing: no CI step runs ${gate.label}`);
      continue;
    }
    for (const step of matching) {
      const where = `${gate.label} in job \`${step.job}\``;
      if (step.continueOnError !== null && step.continueOnError !== "false") {
        problems.push(`neutered: ${where} has continue-on-error: ${step.continueOnError}`);
      }
      if (SWALLOWS_FAILURE.test(step.run ?? "")) {
        problems.push(`neutered: ${where} swallows a non-zero exit in its run command`);
      }
      if (step.ifCondition !== null) {
        problems.push(`conditional: ${where} runs only when \`${step.ifCondition}\``);
      }
    }
  }

  // The reason this criterion exists: an inherited `NODE_ENV=development` makes
  // `next build` die on a spurious prerender error. Agent sessions in this repo
  // inherit exactly that from the dev server that spawned them, so the value
  // must be pinned on the step rather than left to the ambient environment.
  for (const step of stepsRunning(steps, /(?:^|\s)npm\s+run\s+build(?:\s|$)/)) {
    const inlineEnv = /(?:^|\s)NODE_ENV=\S+\s+/.test(step.run ?? "");
    if (!inlineEnv && step.env.NODE_ENV === undefined) {
      problems.push(
        `ambient NODE_ENV: the build step in job \`${step.job}\` does not set NODE_ENV explicitly`,
      );
    }
  }

  return problems;
}

describe("the CI workflow", () => {
  it("is parsed into steps at all", () => {
    // Non-vacuity: every assertion below is a filter over this list. If the
    // extractor silently returned nothing, they would all pass for free.
    const steps = parseSteps(workflowSource);
    expect(steps.length).toBeGreaterThan(10);
    expect(steps.filter((step) => step.run !== null).length).toBeGreaterThan(5);
    expect(new Set(steps.map((step) => step.job))).toContain("test");
  });

  it("runs on pushes and pull requests", () => {
    // A gate that never triggers is not a gate.
    expect(workflowSource).toMatch(/^on:\s*$/m);
    expect(workflowSource).toMatch(/^\s{2}push:\s*$/m);
    expect(workflowSource).toMatch(/^\s{2}pull_request:\s*$/m);
  });

  it("runs the unit suite", () => {
    expect(stepsRunning(parseSteps(workflowSource), /(?:^|\s)npm\s+test(?:\s|$)/)).not.toHaveLength(
      0,
    );
  });

  it.each(GATES)("runs $label", ({ pattern }) => {
    expect(stepsRunning(parseSteps(workflowSource), pattern)).not.toHaveLength(0);
  });

  it("sets NODE_ENV explicitly on every build step", () => {
    const buildSteps = stepsRunning(parseSteps(workflowSource), /(?:^|\s)npm\s+run\s+build(?:\s|$)/);
    expect(buildSteps).not.toHaveLength(0);
    for (const step of buildSteps) {
      const explicit = step.env.NODE_ENV ?? /(?:^|\s)NODE_ENV=(\S+)\s+/.exec(step.run ?? "")?.[1];
      expect(explicit, `job \`${step.job}\` leaves NODE_ENV to the ambient environment`).toBe(
        "production",
      );
    }
  });

  it("keeps every gate able to fail the job", () => {
    expect(gateViolations(workflowSource)).toEqual([]);
  });
});

/**
 * The teeth of the file above. Each fixture is a minimal workflow carrying one
 * specific way of putting the hole back; `gateViolations` must report it. Without
 * these, a parser that quietly matched nothing would keep the suite green while
 * the gates were being removed.
 */
describe("the workflow analyser rejects a weakened workflow", () => {
  const workflow = (verifySteps: string) => `name: CI
on:
  push:
  pull_request:
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
${verifySteps}
`;

  const healthy = workflow(`      - name: Type check
        run: npx tsc --noEmit
      - name: Lint
        run: npm run lint
      - name: Production build
        env:
          NODE_ENV: production
        run: npm run build`);

  it("accepts the healthy control", () => {
    // If this fixture failed, every rejection below would be meaningless.
    expect(gateViolations(healthy)).toEqual([]);
  });

  it("reports a deleted gate", () => {
    const withoutTypecheck = healthy.replace(/      - name: Type check\n        run:.*\n/, "");
    expect(gateViolations(withoutTypecheck)).toEqual([
      "missing: no CI step runs type check (`npx tsc --noEmit`)",
    ]);
  });

  it("reports a gate marked continue-on-error", () => {
    const tolerated = healthy.replace(
      "      - name: Lint\n        run: npm run lint",
      "      - name: Lint\n        continue-on-error: true\n        run: npm run lint",
    );
    expect(gateViolations(tolerated)).toEqual([
      "neutered: lint (`npm run lint`) in job `verify` has continue-on-error: true",
    ]);
  });

  it("reports a gate whose command swallows its exit code", () => {
    const swallowed = healthy.replace("run: npm run lint", "run: npm run lint || true");
    expect(gateViolations(swallowed)).toEqual([
      "neutered: lint (`npm run lint`) in job `verify` swallows a non-zero exit in its run command",
    ]);
  });

  it("reports a gate hidden behind an `if:` condition", () => {
    const conditional = healthy.replace(
      "      - name: Type check\n        run:",
      "      - name: Type check\n        if: github.event_name == 'pull_request'\n        run:",
    );
    expect(gateViolations(conditional)).toEqual([
      "conditional: type check (`npx tsc --noEmit`) in job `verify` runs only when `github.event_name == 'pull_request'`",
    ]);
  });

  it("reports a build step that inherits NODE_ENV from the environment", () => {
    const ambient = healthy.replace("        env:\n          NODE_ENV: production\n", "");
    expect(gateViolations(ambient)).toEqual([
      "ambient NODE_ENV: the build step in job `verify` does not set NODE_ENV explicitly",
    ]);
  });

  it("accepts NODE_ENV pinned inline on the command instead of via env:", () => {
    const inline = healthy.replace(
      "        env:\n          NODE_ENV: production\n        run: npm run build",
      "        run: NODE_ENV=production npm run build",
    );
    expect(gateViolations(inline)).toEqual([]);
  });

  it("does not mistake `npm run lint:prune` for the lint gate", () => {
    // The real workflow echoes that command in a failure hint; matching it would
    // let the actual gate be deleted while this file stayed green.
    const hintOnly = healthy.replace("run: npm run lint", "run: echo 'try npm run lint:prune'");
    expect(gateViolations(hintOnly)).toEqual([
      "missing: no CI step runs lint (`npm run lint`)",
    ]);
  });
});
