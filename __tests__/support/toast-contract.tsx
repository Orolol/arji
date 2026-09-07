/**
 * The contract every toast surface must honour, in one place.
 *
 * `components/notifications/ToastStack.tsx` is the single stack: it portals to
 * `document.body` (so a scrollable page container cannot trap it), announces
 * itself to assistive tech, carries its tone as data, and can always be
 * dismissed by hand. A surface that hand-rolls its own stack fails every one
 * of these — which is exactly what this helper is here to catch.
 *
 * Behaviour beyond the structure (success expiry, hover/focus pause, the
 * MAX_TOASTS ceiling) is pinned once against the primitive itself in
 * `__tests__/toast-stack.test.tsx`; asserting it again per surface would only
 * re-test the same component through five façades.
 */

import { fireEvent, screen, within } from "@testing-library/react";
import { expect } from "vitest";

export interface ToastContractOptions {
  /** The stack's own `data-testid`, forwarded through `ToastStack`. */
  testId: string;
  tone: "success" | "error" | "warning";
  /** The message the surface raised, so the assertion cannot pass on a stale toast. */
  message: string | RegExp;
}

/**
 * Asserts the shared contract and leaves the stack empty, so a caller can
 * chain a second raise without the first one shadowing it.
 */
export function expectSharedToastContract(
  container: HTMLElement,
  { testId, tone, message }: ToastContractOptions,
): void {
  const toast = screen.getByTestId(testId);

  // 1. Portalled: outside the page's own tree, mounted straight on the body.
  //
  // Looked up structurally rather than with `getByRole("region")` on purpose —
  // a toast raised while a Radix dialog is open sits under the `aria-hidden`
  // the dialog stamps on the body's other children, so the ROLE query misses
  // it. That the labelled region is a real region is pinned once, dialog-free,
  // in `../toast-stack.test.tsx`.
  const region = toast.closest("section[aria-label='Notifications']");
  expect(container).not.toContainElement(toast);
  expect(region).not.toBeNull();
  expect(region?.parentElement).toBe(document.body);

  // 2. Announced — a success is polite, anything else interrupts.
  expect(toast).toHaveAttribute("role", tone === "success" ? "status" : "alert");

  // 3. The tone travels as data, identically on every surface.
  expect(toast).toHaveAttribute("data-toast-type", tone);

  // 4. It says what the surface raised.
  if (typeof message === "string") expect(toast.textContent).toContain(message);
  else expect(toast.textContent).toMatch(message);

  // 5. Dismissible by hand, whatever the tone. `hidden: true` for the same
  //    dialog reason as above — the accessible NAME is still computed, only
  //    the aria-hidden filter is lifted.
  fireEvent.click(
    within(toast).getByRole("button", {
      name: "Dismiss notification",
      hidden: true,
    }),
  );
  expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
}
