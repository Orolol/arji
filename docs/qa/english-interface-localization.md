# English interface and localization substrate — E-arij-155

The interface resolves copy through `next-intl`, without locale routes. Module-level
copy tables store typed key references; renderers translate them. The pattern and
its exceptions are documented in `lib/i18n/catalogue.ts`.

## Delivered

- Request-resolved `ui_locale` setting, API validation, root provider, and dynamic
  HTML language; English is the only automatically negotiated complete locale.
  The French seed is available for development with English fallback. No switcher.
- One date, relative-time, number and plural family. Agent-facing formatting stays
  explicitly pinned to `en-US`.
- 2,180 English messages across 46 namespace files (including the review fixes below). The 344 original French
  messages occupy 17 partial namespace files. Already-English messages have no
  French placeholder. Namespace files compose the `en` and `fr` catalogues; the
  index is generated with `npm run i18n:index`.
- Navigation, settings, desk, chat, agents, specification, QA, sessions, tickets,
  registry, releases, imports, documents, routines, GitHub, usage, shared controls,
  and client error fallbacks use catalogue copy. The final hook sweep covers 65
  fallback call sites and passes translated phrases into the agent error helper.
- Fatal CI key coverage, with missing/orphan mutations tested in the source tree.
  The scanner handles separate lexical translator scopes and constant key tables.
  The JSX lint rule covers literal children, copy attributes, conditional branches,
  fallbacks and template fragments. Frame glyphs and literal Git commands are
  declared exceptions; the development harness is excluded.

## Original delivery verification

Measured on 2026-09-07, with the existing installed dependencies verified by
`lockfile-install-consistency.test.ts`. No dependency reinstall was necessary.

- TypeScript: pass.
- Production build with `NODE_ENV=production`: pass.
- Repository ESLint: pass, 28 warnings and no errors.
- Key coverage: 2,141 defined and referenced; no missing or orphan keys.
- Full Vitest suite: 8,506 passed, 1 failed (the known refinement-button flake); 618 files passed, 1 failed.
- System Chrome Playwright: 30 tests passed across the locale, chat layout/focus,
  desk layout/toasts, registry filtering/responsiveness, QA dialog/story controls,
  and TopBar geometry specs. The four locale walkthroughs passed again after screenshot capture was changed to wait for loaded bodies.
- Real-provider tests prove hook errors use provider messages, preserve server
  error text, format status parameters and recover on a successful refresh.
- An AST scan found no French string literals in product `app/` or `components/`;
  French comments and the excluded harness remain. No test files were deleted.

The known `refinement-button.test.tsx` in-flight badge assertion failed in earlier
full runs and passed in a focused rerun. It is recorded on the epic as an occurrence
of the existing flake, not an i18n regression. No assertion was removed or skipped.

## Browser evidence and its limits

The test server ran on port 3288, separate from the orchestrator on 3000. Chrome
opened the following at 1280 × 900 and 390 × 900, captured screenshots, checked
`html[lang=en]`, waited for loading indicators to disappear, and rejected unresolved
catalogue keys, page errors and document-level horizontal overflow:

- Global desk, tickets registry, new ticket, chat, QA, inbox and usage.
- Agents, assignments, prompts and limits.
- Workspace, pipeline, integration and appearance settings.
- New-project and import flows.
- Project desk, specification/memory, QA, releases, session list and session detail.
- Project documents, frictions, GitHub issue triage, Git sync and settings/routines.
- A ticket overlay opened from its deep link, using a seeded ticket and session.

Screenshots were also visually inspected. The existing responsive specs check
relative geometry, reachable controls, focus, filtering, and actual creation paths.
This is coverage of those routes and fixture states, not every possible user-data,
provider, modal or long-text combination. Agent execution and external GitHub
operations were not required for the locale checks; the session/report fixtures
are stored test records.

A separate checkout of **main `77b0039`** and a copy of the scratch database proved
that these defects predate the extraction; they remain separate work:

- B-arij-269: desktop CLI permission-mode labels overlap (the labels were already
  English; observed at 1280px, baseline values checked in source).
- B-arij-270: the mobile ticket title is 0px wide on both main and this branch
  (height 28.5px); the dialog is still named and opens. The locale test pins the
  accessible dialog name and translated conversation band, not title visibility.
- B-arij-271: mobile Full Auto settings controls overlap on both versions.
- B-arij-272: the Spec header action clips on both versions at 390px.

A page-overflow check alone does not detect internal clipping. These observations
must not be summarized as a claim that every mobile layout is flawless.

Chrome measured the actual Space Mono font at 13px: U+0020 advances
**7.9560089px**, U+202F **3.9779968px**, and `Intl.NumberFormat("fr-FR")` groups
`1234` with U+202F. The shared formatter therefore preserves the frame's ordinary
space by replacing no-break group separators with U+0020.

## Scope and integration

Main `77b0039` was merged into this feature branch. Before that merge, main had
24 changed paths since the common ancestor; five overlapped the feature work and
auto-merged cleanly. No migration was added by this epic. No routing/proxy change,
SQL schema change, persisted-message localization, agent-prompt translation,
dev-harness extraction or user-data translation was introduced. Prompt files only
carry the explicit English-formatting comments required by story 2.

The measured reconciliation expires if main advances. This document records code
and local browser/test evidence; the GitHub Actions runner itself was not executed.
The temporary comparison checkout, server, database and scratch browser scripts
were removed. Final scratch-server cleanup is recorded in the ticket comment.

## Review follow-up — 2026-09-07

This follow-up addresses all four findings from the review of `fca06c03`.

- **Story 2, locale-aware formatting:** the shared formatter now offers
  `maxUnit: "year"`, used by the agent editor footer. Its historical thresholds
  are preserved: 30-day months, then years after 12 months. Other surfaces retain
  their existing day ceiling. English boundary tests cover 29, 30, 359, 360 and
  425 days, and French tests exercise the same month/year path.
- **Release captions:** casing applies to the entire translated age with the
  explicit locale. No comparison inspects the English words “just now” or “ago”.
  The DOM now contains `4D AGO` instead of `4d AGO`; the visible English caption
  already used FieldKicker's CSS `uppercase`, so the displayed glyphs are unchanged.
  French ages and a reworded English just-now phrase are covered.
- **Stories 1/4, module-scope copy:** column, priority and pipeline-stage tables
  now carry keys. Their callers resolve them in the inbox, registry filters/rows,
  new-ticket view, bug form, priority badge, status control, CSV export, registry
  API and ticket metadata/activity. Transition reasons and manual epic validation
  also return keys, with the limits interpolated at render. Pipeline chips take
  resolved phrases. The agent-facing priority description stays pinned to English.
  Newly extracted English strings have no French placeholder entries.
- **Client catalogue duplication:** the formatter imports only the two tiny
  Format namespaces. Provider validation imports only English ProviderOptions,
  with its keys constrained to that namespace. Neither helper imports the full
  catalogue. The provider still serializes the selected locale's resolved messages;
  this change removes the duplicate static catalogue, not that required payload.
- **Story 5, regression coverage:** tests exercise real next-intl context with
  changed catalogue values, key-bearing tables, formatter thresholds, and the
  helpers' transitive static import graphs. The generic JSX/key guards still do
  not inventory arbitrary untranslated `lib/` strings; these tests guard the
  specific table families from the review. Friction `ypq9m3Ou7Quz` records that limit.

Regression proof: temporarily restored the pre-fix formatter, release derivation
and provider registry from `fca06c03`, ran their tests, and restored the saved
working files in `finally`. The baseline produced **9 failing assertions across
3 files**. The corresponding fixed run, including translated UI and release-page
checks, passed **86 tests in 5 files**. No tests were deleted or skipped.

Final follow-up verification on the existing installation (lockfile/install
consistency: 6/6 passing; no reinstall):

| Check | Result |
| --- | --- |
| Full `npm test` | **621 files, 8,524 tests passed** |
| `tsc --noEmit` | Pass |
| Repository ESLint | Pass, 28 warnings, zero errors |
| Key coverage | 2,180 defined/referenced; zero missing/orphan |
| Production build, `NODE_ENV=production` | Pass |
| Chrome, production server at port 3407 | **10 committed Playwright tests passed**, plus one isolated French-locale probe |

The first full follow-up run had one stale assertion in `epic-create-dialog`:
8,523 passed and 1 failed. It expected the former English-valued constant instead
of rendered copy. Its English assertion was migrated; the final full run above
passed. The known `refinement-button` flake did not occur in either full run.

Browser coverage: the four existing locale walkthroughs revisited the global and
project routes listed above at 1280×900 and 390×900, including all settings tabs,
ticket creation and the ticket overlay. The new regression test checked release
age captions at both widths, just-now handling, and an agent created 425 days ago.
Five existing registry filter/responsiveness tests also passed, exercising populated
rows, priority/status labels, filtering, history and controls at 390, 768, 1280 and
1440px. Screenshots were visually inspected for the new-ticket view, ticket overlay,
registry (empty and populated), inbox empty state, release captions and agent editor.
Conditional validation and translated table copy are covered by component tests;
the browser inbox pass did not seed a populated inbox. The existing B-arij-269 CLI
permission overlap and B-arij-270 mobile ticket header clipping remain outside this
fix. French is still an incomplete seed; e.g. its release label falls back to CURRENT.

The French probe used a separate scratch database, restored the locale row in
`finally`, and was deleted afterwards so a workspace-setting mutation cannot race
the normal parallel browser suite. The committed browser regression test changes
no workspace settings. Durable screenshots attached to this session: `DST7Hb9PAzhE`
(French release age at 390px) and `4B8a2w0j2ZdB` (agent year age).

Bundle measurement: the pre-fix production build contained
`.next/static/chunks/29xf26xxjfe18.js` (115,448 bytes), including both complete
catalogues. The new production static chunks contain neither `Réglages` nor
`Intégrations`. The two helper graphs now reach just three namespace files:
English Format (57 bytes), French Format (60 bytes), and English ProviderOptions
(1,823 bytes), **1,940 bytes of source JSON** in total. These source sizes are not
compressed transfer sizes; small namespace data may occur in multiple route chunks.
The resolved provider message payload remains, as described above.

Reconciled against local `main` **77b00390**, unchanged during this follow-up; this
measurement expires as main advances. No migrations, schema, locale routing,
proxy/middleware or excluded harness changes. Test servers stopped; owned scratch
projects/repositories, scratch database directory and temporary browser probe removed.
The port-3000 orchestrator was left running. Production `.next` and ignored browser
reports are verification output; the tracked tree contains only this fix.
