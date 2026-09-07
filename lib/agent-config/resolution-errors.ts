/**
 * Raised when an id names a composite with no usable member left.
 *
 * A composite is emptied by DELETING its last member — the membership rows
 * cascade — so this is reachable state, not a corrupt database.
 *
 * WHO CATCHES IT decides the behaviour, and the split is deliberate:
 *
 *  - A caller that NAMED this composite for a dispatch (an explicit choice,
 *    a conversation) gets the throw. Falling back to whatever the builtin
 *    chain happens to hold would run the work on an agent the user did not
 *    ask for, which is the "resolve to an arbitrary default" outcome the
 *    story explicitly refuses.
 *  - The BACKGROUND CHAIN — a role assignment, the designated default —
 *    catches it in `resolveNamedAgentIdInChain` and continues to the next
 *    link, exactly as it already does for a deleted agent. Those links end in
 *    a builtin fallback by design, and throwing there would take down every
 *    unassigned resolution in the app.
 */
export class CompositeAgentUnusableError extends Error {
  readonly compositeAgentId: string;
  /** Kept for the chain's fall-through log, which names what it skipped. */
  readonly compositeName: string;

  constructor(compositeAgentId: string, compositeName: string) {
    super(
      `Composite agent "${compositeName}" has no members left; it cannot dispatch anything. Add a member, or pick another agent.`,
    );
    this.name = "CompositeAgentUnusableError";
    this.compositeAgentId = compositeAgentId;
    this.compositeName = compositeName;
  }
}

