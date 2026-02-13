# UAT Checklist: Unified Chat Final Cutover

## Build Preconditions
- [ ] App starts with no runtime errors.
- [ ] Database is backed up.
- [ ] Migration artifact directory is writable: `data/migrations/unified-chat-cutover/`.

## Entry Point Validation
- [ ] Open project board and click `Chat`: unified left workspace opens.
- [ ] Click `New Epic`: same workspace opens and creates/selects an epic-creation conversation.
- [ ] Project layout has no right-side chat toggle/button.

## History and Tab Parity
- [ ] Existing conversations are visible in unified tabs.
- [ ] Tab labels and taxonomy match expected legacy semantics.
- [ ] Conversation ordering follows oldest-first behavior.
- [ ] Status indicators match active/generating semantics.

## Message and Context Continuity
- [ ] Existing conversation history loads fully.
- [ ] Sending new messages works in brainstorm and epic-creation tabs.
- [ ] Provider selection behavior matches lock rules (editable before first message only).

## Session and Activity Alignment
- [ ] Active chat/build/review activities appear in monitor data.
- [ ] Cancelling registry-backed chat activity succeeds through session cancellation endpoint.
- [ ] No duplicate/divergent active activity records appear.

## Migration Integrity
- [ ] Backup file exists for the project migration run.
- [ ] Report file exists for the project migration run.
- [ ] Report indicates zero missing and zero duplicate conversation/message IDs.
- [ ] Orphan message reassignment (if any) is reported and traceable.

## Regression Journeys
- [ ] Ideation flow: brainstorm chat -> spec generation still works.
- [ ] Epic creation flow: epic conversation -> create epic action still works.
- [ ] Planning/build workflows still show session activity with accurate status.

## Release Gate
- [ ] Zero critical chat-convergence defects remain open.
- [ ] QA sign-off recorded with migration report references.
