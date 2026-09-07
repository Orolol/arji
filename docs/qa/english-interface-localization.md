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
- 2,141 English messages across 46 namespace files. The 344 original French
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

## Verification

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
