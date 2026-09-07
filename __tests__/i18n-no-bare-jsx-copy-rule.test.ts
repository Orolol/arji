/**
 * The ESLint guard that keeps the interface extracted.
 *
 * These cases are the rule's CONTRACT, and the exception list is the part
 * worth pinning: the Piscine frames are drawn with `·`, `—`, `→` and `⌘` as
 * furniture, and a rule that flagged those would be turned off within a week.
 */
import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import rule from "../eslint-rules/no-bare-jsx-copy.mjs";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe("i18n/no-bare-jsx-copy", () => {
  it("flags bare copy and allows the frame's furniture", () => {
    ruleTester.run("no-bare-jsx-copy", rule as never, {
      valid: [
        // The extracted shape this whole epic exists to produce.
        { code: "const A = () => <p>{t('desk.empty')}</p>;" },
        // Frame furniture: identical in every language, and on the mono grid.
        { code: "const A = () => <span>·</span>;" },
        { code: "const A = () => <span>—</span>;" },
        { code: "const A = () => <span>→</span>;" },
        { code: "const A = () => <span>⌘</span>;" },
        { code: "const A = () => <span>42</span>;" },
        { code: "const A = () => <span>%</span>;" },
        // A single letter is a glyph or an initial, not a sentence.
        { code: "const A = () => <span>K</span>;" },
        // Not copy: the DOM surface is string-typed and opt-in guards it.
        { code: "const A = () => <div className='flex items-center' />;" },
        { code: "const A = () => <a href='/tickets' data-testid='reg-row' />;" },
        // An exception declared once, in the config, as an option.
        {
          code: "const A = () => <span>DEV HARNESS</span>;",
          options: [{ allowPattern: "^DEV HARNESS$" }],
        },
      ],
      invalid: [
        {
          code: "const A = () => <p>Ready to land</p>;",
          errors: [{ messageId: "bareText" }],
        },
        {
          code: "const A = () => <p>{'Ready to land'}</p>;",
          errors: [{ messageId: "bareText" }],
        },
        {
          code: "const A = () => <button title='Ready to land' />;",
          errors: [{ messageId: "bareAttribute" }],
        },
        {
          code: "const A = () => <img alt='A screenshot of the desk' />;",
          errors: [{ messageId: "bareAttribute" }],
        },
        {
          code: "const A = () => <input placeholder='Search tickets' />;",
          errors: [{ messageId: "bareAttribute" }],
        },
        {
          code: "const A = () => <button aria-label='Close the overlay' />;",
          errors: [{ messageId: "bareAttribute" }],
        },
        // French is copy like any other — the rule is language-blind, which is
        // what stops the mix from coming back.
        {
          code: "const A = () => <p>Prêt à lander</p>;",
          errors: [{ messageId: "bareText" }],
        },
      ],
    });
  });
});

describe("i18n/no-bare-jsx-copy — the copy-prop suffix family", () => {
  it("flags the Piscine copy props, and leaves the enum-ish ones alone", () => {
    ruleTester.run("no-bare-jsx-copy", rule as never, {
      valid: [
        // Enum-ish props are the Piscine vocabulary, not copy.
        { code: "const A = () => <StrataBand stratum='next' density='full' />;" },
        { code: "const A = () => <PillButton outlineTone='neutral' variant='ghost' />;" },
        { code: "const A = () => <SegmentedControl chrome='bordered' />;" },
        // A URL is not copy, and must not be caught by the `Title$` suffix.
        { code: "const A = () => <TicketRow titleHref='/tickets/42' />;" },
        { code: "const A = () => <Icon aria-hidden='true' />;" },
      ],
      invalid: [
        {
          code: "const A = () => <BandHeader label='CLI options' />;",
          errors: [{ messageId: "bareAttribute" }],
        },
        {
          code: "const A = () => <BandHeader meta='applies to code sessions' />;",
          errors: [{ messageId: "bareAttribute" }],
        },
        {
          code: "const A = () => <PillButton pendingLabel='Saving…' />;",
          errors: [{ messageId: "bareAttribute" }],
        },
        {
          code: "const A = () => <PermanentDeleteDialog confirmLabel='Delete agent' />;",
          errors: [{ messageId: "bareAttribute" }],
        },
        {
          code: "const A = () => <Dialog dialogTitle='Delete this agent?' />;",
          errors: [{ messageId: "bareAttribute" }],
        },
        {
          code: "const A = () => <Field usageHint='One command per line' />;",
          errors: [{ messageId: "bareAttribute" }],
        },
      ],
    });
  });
});
