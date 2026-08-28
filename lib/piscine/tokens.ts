/**
 * Piscine token maps — the TS side of `app/globals.css`.
 *
 * Typed lookup tables so no component ever hard-codes a hex. Consumed by every
 * Piscine primitive and by any screen that needs a raw colour STRING rather
 * than a Tailwind utility (chart fills, inline SVG, `style` props, canvas).
 *
 * Every value is a `var(--token)` string, never a literal hex. That is the whole
 * point: the maps resolve through the CSS custom properties, so they follow the
 * day palette under `:root` and the night palette under `.dark` with no code
 * change here. If you ever find yourself writing `#` in this file, stop.
 *
 * When a Tailwind utility will do (`bg-strata-live`, `text-project-2-deep`,
 * `border-strata-you-under`), prefer the utility — these maps are for the cases
 * where a class name is not an option.
 */

/** The five attention strata, in their fixed vertical order of urgency. */
export const STRATA = ["live", "you", "land", "next", "feed"] as const;

export type Stratum = (typeof STRATA)[number];

/**
 * Every ground a Piscine surface can be printed on: the five strata plus the
 * two neutral ones (`card` = a white card, `paper` = the shell background).
 *
 * This is THE vocabulary for the "which ground am I on?" axis. Any primitive
 * that needs to know its ground takes a prop of this type named `stratum`
 * (or `<part>Stratum`), never `ground`, `tone` or `variant`. `fill` is the
 * different question — "what colour am I painting MYSELF?" — and stays a
 * per-component enum.
 */
export type SurfaceStratum = Stratum | "card" | "paper";

/**
 * Per-stratum ground + figure colours.
 *
 * - `ground` — the band fill. In night ALL FIVE collapse to the same warm ink;
 *   the stratum is then legible only from `deep` + the 3px `under` rule. Never
 *   rely on the ground to tell strata apart.
 * - `deep`   — labels, chrono numerals, the stratum's loud figure colour.
 * - `mid`    — secondary text on the ground.
 * - `under`  — the 3px label underline.
 */
export const STRATUM: Record<
  Stratum,
  { ground: string; deep: string; mid: string; under: string }
> = {
  live: {
    ground: "var(--strata-live)",
    deep: "var(--strata-live-deep)",
    mid: "var(--strata-live-mid)",
    under: "var(--strata-live-under)",
  },
  you: {
    ground: "var(--strata-you)",
    deep: "var(--strata-you-deep)",
    mid: "var(--strata-you-mid)",
    under: "var(--strata-you-under)",
  },
  land: {
    ground: "var(--strata-land)",
    deep: "var(--strata-land-deep)",
    mid: "var(--strata-land-mid)",
    under: "var(--strata-land-under)",
  },
  next: {
    ground: "var(--strata-next)",
    deep: "var(--strata-next-deep)",
    mid: "var(--strata-next-mid)",
    under: "var(--strata-next-under)",
  },
  feed: {
    // There is deliberately no --strata-feed-mid: frames 7a and 8b use the deep
    // linden for helper text on the composer/spec/persona grounds. Shipping the
    // frame behaviour rather than inventing a token the design never used.
    ground: "var(--strata-feed)",
    deep: "var(--strata-feed-deep)",
    mid: "var(--strata-feed-deep)",
    under: "var(--strata-feed-under)",
  },
};

/**
 * Class names that scope the shared ambient-activity animations to a stratum.
 * Put one on a band (or on the indicator itself) and every `.breathing-dot`,
 * `.progress-track` and `.crawl-fill` beneath it adopts that stratum's figure
 * colours. Defined in `app/globals.css`.
 */
export const STRATUM_MOTION_CLASS: Record<Stratum, string> = {
  live: "stratum-live",
  you: "stratum-you",
  land: "stratum-land",
  next: "stratum-next",
  feed: "stratum-feed",
};

/** The fixed project-identity cycle. Colour = WHO, never state. */
export const PROJECT_TONES = [1, 2, 3, 4] as const;

export type ProjectTone = (typeof PROJECT_TONES)[number];

/**
 * Per-project chip fill / deep text / mid bar.
 *
 * - `fill` — chip and pill background.
 * - `deep` — text on that fill (and the project label in a mono rail).
 * - `mid`  — bar fills in BY PROJECT charts.
 *
 * In night the pastel migrates to `deep` and `fill` becomes a dark mix, so a
 * `fill`/`deep` pair stays AA in both themes. Always use them as a pair.
 */
export const PROJECT: Record<
  ProjectTone,
  { fill: string; deep: string; mid: string }
> = {
  1: {
    fill: "var(--project-1)",
    deep: "var(--project-1-deep)",
    mid: "var(--project-1-mid)",
  },
  2: {
    fill: "var(--project-2)",
    deep: "var(--project-2-deep)",
    mid: "var(--project-2-mid)",
  },
  3: {
    fill: "var(--project-3)",
    deep: "var(--project-3-deep)",
    mid: "var(--project-3-mid)",
  },
  4: {
    fill: "var(--project-4)",
    deep: "var(--project-4-deep)",
    mid: "var(--project-4-mid)",
  },
};

/**
 * Walk the 4-colour cycle. `index` is the project's stored `colorIndex`
 * (0-based); anything out of range or negative wraps rather than throwing, so a
 * row that predates the column can pass a hash and still get a stable tone.
 */
export function projectTone(index: number): ProjectTone {
  const i = ((Math.trunc(index) % PROJECT_TONES.length) + PROJECT_TONES.length) %
    PROJECT_TONES.length;
  return PROJECT_TONES[i];
}

/**
 * Segments of the composed-prompt anatomy bar (frame 8b). SPEC, MEMORY and
 * TICKET-DIFF reuse the stratum underlines they are conceptually tied to
 * (linden = writing, turquoise = live work, pool = queue/ticket); SYSTEM,
 * PERSONA and DOCS have their own neutral/rose/violet roles.
 */
export const PROMPT_SEGMENT: Record<
  "system" | "persona" | "spec" | "memory" | "ticket" | "docs",
  string
> = {
  system: "var(--prompt-system)",
  persona: "var(--prompt-persona)",
  spec: "var(--strata-feed-under)",
  memory: "var(--strata-live-under)",
  ticket: "var(--strata-next-under)",
  docs: "var(--prompt-docs)",
};
