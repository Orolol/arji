/**
 * `i18n/no-bare-jsx-copy` — a user-facing string in JSX must come from the
 * catalogue, not from the source file.
 *
 * WHY A RULE AND NOT A REVIEW HABIT. The interface was swept to English and
 * extracted to keys once; without a mechanical gate the next screen reverts
 * it one literal at a time, and the sweep gets paid twice. This is the guard
 * that makes the extraction stick.
 *
 * WHAT IT FLAGS
 *   <p>Ready to land</p>                     JSX text
 *   <p>{"Ready to land"}</p>                 a literal child
 *   <button title="Ready to land" />         a copy-bearing attribute
 *
 * WHAT IT DOES NOT FLAG, and why each is a real exception rather than a hole:
 *   - Punctuation, arrows, separators and mono glyphs: `·`, `—`, `→`, `⌘`.
 *     These are the Piscine frame's own furniture, they are identical in every
 *     language, and putting them in the catalogue would invite a translator to
 *     "fix" them off the mono grid.
 *   - A single character, and strings with no letter at all (`42`, `%`, `+`).
 *   - Anything matching `allowPattern` (a rule OPTION, so an exception is
 *     declared once in the config where it can be reviewed — never as a
 *     scattered `eslint-disable` comment, which is how a rule quietly dies).
 *
 * Attributes are opt-IN (`copyAttributes`, `copyAttributePattern`) rather than
 * opt-out: `className`, `href`, `id`, `data-testid` and the rest of the DOM
 * surface are string-typed and are not copy, so a deny-list would be wrong by
 * default.
 *
 * The PATTERN half is what makes the opt-in list maintainable. The Piscine
 * primitives spell copy as `label`, `meta`, `caption`, `hint`, `title`,
 * `placeholder`, `pendingLabel`, and the surfaces above them add
 * `confirmLabel`, `emptyLabel`, `submitLabel`, `dialogTitle` and a dozen more
 * of the same shape. Enumerating them guarantees the list rots one new prop at
 * a time, so a name ENDING in Label/Caption/Hint/Placeholder/Title/Text counts
 * too. `titleHref` is a URL and does not match — the suffix has to be the end.
 */

/** Letters in any script — a string with none of them is not copy. */
const HAS_LETTER = /\p{L}/u;

const DEFAULT_COPY_ATTRIBUTES = [
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "caption",
  "hint",
  "label",
  "meta",
  "placeholder",
  "summary",
  "text",
  "title",
  "tooltip",
];

/** The same idea as the list, for the names nobody has enumerated yet. */
const DEFAULT_COPY_ATTRIBUTE_PATTERN = "(Label|Caption|Hint|Placeholder|Title|Text)$";

function isCopy(raw, allowPattern) {
  const text = raw.trim();
  if (!text) return false;
  if (!HAS_LETTER.test(text)) return false;
  // One letter is a glyph or an initial, not a sentence.
  if (text.replace(/[^\p{L}]/gu, "").length < 2) return false;
  if (allowPattern && allowPattern.test(text)) return false;
  return true;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "User-facing strings in JSX must resolve from the i18n catalogue, not be written inline.",
    },
    schema: [
      {
        type: "object",
        properties: {
          /** Strings that are legitimately not copy, as one reviewable regex. */
          allowPattern: { type: "string" },
          /** Attributes whose string value is read by a user. */
          copyAttributes: { type: "array", items: { type: "string" } },
          /** Attribute NAMES matching this are copy too — the suffix family. */
          copyAttributePattern: { type: "string" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      bareText:
        'Bare user-facing string in JSX: {{text}}. Resolve it from the catalogue — `const t = useTranslations("Ns")` then `t("some.key")` — per lib/i18n/catalogue.ts.',
      bareAttribute:
        'Bare user-facing string in the `{{attribute}}` attribute: {{text}}. Resolve it from the catalogue per lib/i18n/catalogue.ts.',
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const allowPattern = options.allowPattern ? new RegExp(options.allowPattern, "u") : null;
    const copyAttributes = new Set(options.copyAttributes ?? DEFAULT_COPY_ATTRIBUTES);
    const copyAttributePattern = new RegExp(
      options.copyAttributePattern ?? DEFAULT_COPY_ATTRIBUTE_PATTERN,
      "u",
    );
    const show = (text) => JSON.stringify(text.trim().slice(0, 40));

    return {
      JSXText(node) {
        if (isCopy(node.value, allowPattern)) {
          context.report({ node, messageId: "bareText", data: { text: show(node.value) } });
        }
      },

      // `{"Ready to land"}` as a child — the same copy, one syntax along.
      JSXExpressionContainer(node) {
        if (node.parent?.type !== "JSXElement" && node.parent?.type !== "JSXFragment") return;
        const expression = node.expression;
        if (expression?.type !== "Literal" || typeof expression.value !== "string") return;
        if (isCopy(expression.value, allowPattern)) {
          context.report({
            node: expression,
            messageId: "bareText",
            data: { text: show(expression.value) },
          });
        }
      },

      JSXAttribute(node) {
        const name =
          node.name.type === "JSXNamespacedName"
            ? `${node.name.namespace.name}:${node.name.name.name}`
            : node.name.name;
        if (!copyAttributes.has(name) && !copyAttributePattern.test(name)) return;
        const value = node.value;
        const literal =
          value?.type === "Literal"
            ? value
            : value?.type === "JSXExpressionContainer" && value.expression.type === "Literal"
              ? value.expression
              : null;
        if (!literal || typeof literal.value !== "string") return;
        if (isCopy(literal.value, allowPattern)) {
          context.report({
            node: literal,
            messageId: "bareAttribute",
            data: { attribute: name, text: show(literal.value) },
          });
        }
      },
    };
  },
};
