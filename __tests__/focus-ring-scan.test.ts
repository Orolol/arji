/**
 * B-arij-206 — the focus-ring sweep loses a control when a comment contains a
 * backtick.
 *
 * `__tests__/focus-ring-paints.test.tsx` can only assert on the sites it finds,
 * so its scanner is the load-bearing part. This file tests the scanner itself,
 * against hand-written sources, because the interesting inputs are exactly the
 * ones a real component would never let you construct on demand.
 *
 * THE DEFECT. The scanner used to pull literals out with a regex that also
 * matched backticks, and to treat comments as a joinable separator by matching
 * them with a second regex. Neither knows what the other is looking at, so a
 * comment naming a utility between backticks — this repository's own comment
 * convention — read as a template literal. The phantom literal broke the run of
 * adjacent literals in two, neither half carried both `outline-none` and the
 * focus ring, and the control silently left the sweep. Observed on
 * `components/tickets-registry/RegistryRow.tsx`:
 *
 *     × finds the sites to check — expected 39 to be greater than or equal to 40
 *
 * A count, naming nothing. Over the real tree the hole hid 8 sites, including
 * two controls of the app's one chrome (`top-bar-home`, `top-bar-add-project`,
 * behind the backticked block comment at `TopBar.tsx:401`).
 */

import { describe, expect, it } from "vitest";

import {
  adjacentClassLists,
  describeSite,
  elementClassLists,
  lexSource,
  outlinePairingSites,
  undeclaredFocusSites,
} from "./helpers/class-list-scan";

/** The pairing the sweep exists for, split over two literals like real code. */
const CLEAR = `"rounded-full bg-action outline-none",`;
const RING = `"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",`;

function component(between: string): string {
  return `export function Control() {
  return (
    <button
      className={cn(
        ${CLEAR}
        ${between}
        ${RING}
      )}
    />
  );
}
`;
}

describe("the scanner keeps one element's class literals together", () => {
  it("across a plain comment", () => {
    const sites = outlinePairingSites(component("// a plain comment"), "f.tsx");

    expect(sites).toHaveLength(1);
    expect(sites[0].classes).toContain("outline-none");
    expect(sites[0].classes).toContain("focus-visible:outline-2");
  });

  /**
   * THE REGRESSION. A comment naming utilities between backticks is how this
   * repository writes comments; the old scanner read the pair of backticks as
   * a template literal and cut the element in two.
   */
  it("across a comment containing a backticked utility name", () => {
    const sites = outlinePairingSites(
      component("// `outline-solid` states the style the ring resolves through."),
      "f.tsx",
    );

    expect(
      sites,
      "a backtick in a comment must not split one element's class list in two",
    ).toHaveLength(1);
    expect(sites[0].classes).toContain("outline-none");
    expect(sites[0].classes).toContain("focus-visible:outline-2");
  });

  it("across a block comment containing an odd number of backticks", () => {
    const sites = outlinePairingSites(
      component("/* `min-w-0 lets it shrink. See `flex-1` above. */"),
      "f.tsx",
    );

    expect(sites).toHaveLength(1);
    expect(sites[0].classes).toContain("focus-visible:outline-2");
  });

  /** An apostrophe in prose is the same hole wearing a different quote. */
  it("across a comment containing an apostrophe", () => {
    const sites = outlinePairingSites(
      component("// it's the ring the keyboard user sees"),
      "f.tsx",
    );

    expect(sites).toHaveLength(1);
    expect(sites[0].classes).toContain("focus-visible:outline-2");
  });

  /** And `//` inside a string is not the start of a comment. */
  it("without mistaking a URL inside a string for a comment", () => {
    const source = `const help = "https://example.test/a";
${component("// after a url-bearing literal")}`;
    const sites = outlinePairingSites(source, "f.tsx");

    expect(sites).toHaveLength(1);
    expect(sites[0].classes).toContain("focus-visible:outline-2");
  });
});

describe("the scanner still stops where it should", () => {
  /**
   * The conservative half of the contract. A ring that only applies when a
   * condition holds must NOT be merged into the base class list, or the sweep
   * would report a ring that paints on one branch only as universally fine.
   */
  it("does not merge a conditional branch into the base class list", () => {
    const source = component("").replace(RING, `enabled && ${RING}`);

    expect(outlinePairingSites(source, "f.tsx")).toHaveLength(0);
  });

  it("does not join two literals separated by an expression", () => {
    const lists = adjacentClassLists(`cn("a", x, "b")`, "f.tsx");

    expect(lists.map((l) => l.classes)).toEqual([["a"], ["b"]]);
  });

  it("drops ${…} holes rather than fusing the utilities around them", () => {
    const lists = adjacentClassLists("cn(`px-2 ${gap} py-1`)", "f.tsx");

    expect(lists[0].classes).toEqual(["px-2", "py-1"]);
  });

  it("does not read a regex literal's contents as a string", () => {
    const source = `const q = /["'\`]/g;
${component("// after a quote-bearing regex")}`;
    const sites = outlinePairingSites(source, "f.tsx");

    expect(sites).toHaveLength(1);
  });

  it("does not read a JSX self-closing slash as a regex", () => {
    const source = `<Icon name="x" />
${component("// after a self-closing tag")}`;

    expect(outlinePairingSites(source, "f.tsx")).toHaveLength(1);
  });

  /**
   * THE SECOND REGRESSION, same shape as the first: a lexer that guesses at
   * TSX rather than parsing it. `/` after `<` cannot end an expression, so a
   * hand-rolled "is this a regex?" test opens a regex on the slash of a
   * closing tag and blanks everything up to the next slash — here the whole
   * `className` of the next element on the line. The control leaves the sweep
   * with nothing naming it, and a second site anywhere else in the file keeps
   * the per-file inventory green.
   */
  it("does not read a JSX closing tag's slash as a regex", () => {
    const source =
      `<div><span>x</span>` +
      `<input className="outline-none focus-visible:outline-2" /></div>`;
    const sites = outlinePairingSites(source, "f.tsx");

    expect(
      sites,
      "the slash of </span> must not swallow the next element's class list",
    ).toHaveLength(1);
    expect(sites[0].classes).toContain("outline-none");
  });

  /** The self-closing slash of a *preceding* sibling, on the same line. */
  it("keeps a control visible after a same-line self-closed sibling", () => {
    const source = `<Row><Badge label="x" /><input className="outline-none" /></Row>`;

    expect(undeclaredFocusSites(source, "f.tsx")).toHaveLength(1);
  });

  it("emits both literals of two same-line JSX siblings", () => {
    const source = `<b><i className="a" />text</i><u className="b" /></b>`;

    expect(lexSource(source).literals.map((l) => l.value)).toEqual(["a", "b"]);
  });

  /** And a real division still is not a regex. */
  it("does not lose a class list after a division", () => {
    const source = `const half = width / 2;
${component("// after an arithmetic slash")}`;

    expect(outlinePairingSites(source, "f.tsx")).toHaveLength(1);
  });
});

describe("lexSource blanks what it consumes, keeping every offset", () => {
  it("returns a skeleton of the same length", () => {
    const source = `const a = "cls"; // \`x\`\nconst b = /re/;`;

    expect(lexSource(source).skeleton).toHaveLength(source.length);
  });

  it("keeps newlines so line numbers survive", () => {
    const source = `/*\n\n*/ "cls"`;
    const { literals, skeleton } = lexSource(source);

    expect(skeleton.split("\n")).toHaveLength(3);
    expect(literals.map((l) => l.value)).toEqual(["cls"]);
  });
});

/**
 * The second rule, and the reason it needs a coarser grouping than the first.
 * B-arij-203: an element that clears the outline and declares no focus
 * affordance at all. `focus-visible:outline-solid` repairs nothing there —
 * there is no ring declaration to repair.
 */
describe("elements that clear the outline and declare nothing", () => {
  it("flags a bare outline-none on a control", () => {
    const source = `<input className="bg-transparent outline-none" />`;

    expect(undeclaredFocusSites(source, "f.tsx")).toHaveLength(1);
  });

  it("flags a variant-scoped clear such as focus:outline-none", () => {
    const source = `<input className="bg-transparent focus:outline-none" />`;
    const sites = undeclaredFocusSites(source, "f.tsx");

    expect(sites).toHaveLength(1);
    expect(sites[0].classes).toContain("focus:outline-none");
  });

  it("clears an element that declares a focus affordance that draws", () => {
    const source = `<input className="border outline-none focus-visible:border-ring" />`;

    expect(undeclaredFocusSites(source, "f.tsx")).toHaveLength(0);
  });

  /**
   * A focus VARIANT is not a focus AFFORDANCE. An offset positions a ring that
   * is not there; a zero-width ring draws nothing; a colour with no width or
   * style paints nothing either. Accepting any `focus-visible:*` as a
   * replacement is how the reported shape — clears the outline, offers
   * nothing — walks straight past this rule.
   *
   * Neither does the paint sweep catch these: it only looks at class lists
   * declaring `focus-visible:outline-<n>`, and none of them do.
   *
   * A COLOUR IS NOT A WIDTH. Tailwind's preflight sets `border: 0 solid` on
   * every element, so `focus-visible:border-<colour>` on an element that
   * declares no border width paints nothing — the same shape as this epic's
   * original defect, one property over. The colour cases below are therefore
   * split by whether the element declares a width for that family to colour.
   */
  it.each([
    ["an outline offset alone", "focus-visible:outline-offset-2"],
    ["a negative outline offset alone", "focus-visible:-outline-offset-2"],
    ["a zero-width ring", "focus-visible:ring-0"],
    ["a ring offset alone", "focus-visible:ring-offset-2"],
    ["an outline colour alone", "focus-visible:outline-ring"],
    ["a ring colour alone", "focus-visible:ring-ring"],
    ["a transparent outline", "focus-visible:outline-2 focus-visible:outline-transparent"],
    ["a cleared shadow", "focus-visible:shadow-none"],
    ["a border colour with no border width", "focus-visible:border-border-strong"],
  ])("flags an element whose only focus utility is %s", (_what, utility) => {
    const source = `<input className="outline-none ${utility}" />`;
    const sites = undeclaredFocusSites(source, "f.tsx");

    expect(
      sites,
      `${utility} draws nothing, so it is not a replacement affordance`,
    ).toHaveLength(1);
  });

  it.each([
    ["an outline width", "focus-visible:outline-2"],
    ["an arbitrary outline width", "focus-visible:outline-[3px]"],
    ["an outline style", "focus-visible:outline-dashed"],
    ["a ring width", "focus-visible:ring-2 focus-visible:ring-ring"],
    ["a bare ring", "focus-visible:ring"],
    ["a border colour over a real border", "border focus-visible:border-border-strong"],
    ["a border width", "focus-visible:border-2"],
    ["a shadow", "focus-visible:shadow-lg"],
    ["a background change", "focus-visible:bg-elevated"],
    ["an underline", "focus-visible:underline"],
  ])("accepts %s as a replacement affordance", (_what, utility) => {
    const source = `<input className="outline-none ${utility}" />`;

    expect(undeclaredFocusSites(source, "f.tsx")).toHaveLength(0);
  });

  /** Stacked variants must not hide the utility from the whitelist. */
  it("reads the utility through a stacked variant", () => {
    const source = `<input className="outline-none md:focus-visible:outline-2" />`;

    expect(undeclaredFocusSites(source, "f.tsx")).toHaveLength(0);
  });

  /**
   * Half of a control's class list routinely lives in a named constant that
   * `cn(…)` spreads in — `FieldBoxInput` keeps its 1.5px border in `BOX`.
   * Reading only the inline literals turns that into a border colour with no
   * border to colour, and the rule accuses a control whose affordance is real.
   */
  it("resolves a class constant the use site spreads in", () => {
    const source = `const BOX = "rounded-[10px] border-[1.5px] border-border";
export function Field() {
  return (
    <input
      className={cn(BOX, "outline-none", "focus-visible:border-border-strong")}
    />
  );
}`;

    expect(
      undeclaredFocusSites(source, "f.tsx"),
      "BOX declares the border width that makes the focus colour visible",
    ).toHaveLength(0);
  });

  /**
   * The same resolution in the other direction, and the reason it is not
   * merely a way to silence the rule: a constant carrying `outline-none` used
   * to hide the clear itself, so the element was never even examined.
   */
  it("flags a control whose constant clears the outline for nothing", () => {
    const source = `const CHIP = "rounded-full px-2 outline-none";
export function Chip() {
  return <button className={cn(CHIP, "text-muted-foreground")} />;
}`;

    const sites = undeclaredFocusSites(source, "f.tsx");

    expect(sites).toHaveLength(1);
    expect(sites[0].classes).toContain("outline-none");
  });

  /**
   * Why this rule groups by element and not by adjacency: `CheckMark` hangs
   * its ring off `onToggle &&` and `UpNextBand` off a `selected` ternary. Under
   * adjacency both read as a bare `outline-none` and the sweep would accuse two
   * correct controls.
   */
  it("sees a ring that hangs off a conditional on the same element", () => {
    const source = `<button className={cn(
      "shadow-none outline-none",
      onToggle &&
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring",
    )} />`;

    expect(undeclaredFocusSites(source, "f.tsx")).toHaveLength(0);
  });

  it("sees a ring declared through a cn() bound to a variable", () => {
    const source = `const classes = cn(
      "outline-none",
      checked ? "bg-action" : "bg-transparent",
      "focus-visible:outline-2 focus-visible:outline-solid",
    );`;

    expect(undeclaredFocusSites(source, "f.tsx")).toHaveLength(0);
  });

  /**
   * A module-level class constant is not an element: its affordance
   * legitimately lives at the use site, so it must not be accused on its own.
   */
  it("ignores a bare string constant that belongs to no element", () => {
    const source = `const CHIP_BASE = "rounded-full outline-none";`;

    expect(undeclaredFocusSites(source, "f.tsx")).toHaveLength(0);
  });

  it("groups every literal of one className attribute together", () => {
    const source = `<b className={cn("a", cond && "b", cn("c"))} />`;
    const lists = elementClassLists(source, "f.tsx");

    expect(lists).toHaveLength(1);
    expect(lists[0].classes).toEqual(["a", "b", "c"]);
  });
});

describe("a failure names the site", () => {
  it("renders file, line and the whole class list", () => {
    const site = { file: "components/x.tsx", line: 12, classes: ["a", "b"] };

    expect(describeSite(site)).toBe("components/x.tsx:12 — a b");
  });

  it("reports the line the class list starts on", () => {
    const source = `\n\n<b className="outline-none focus-visible:outline-2" />`;

    expect(outlinePairingSites(source, "f.tsx")[0].line).toBe(3);
  });
});
