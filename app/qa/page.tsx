import { QaScreen } from "@/components/qa/QaScreen";
import { TicketOverlayProvider } from "@/components/ticket/TicketOverlayProvider";

/**
 * "/qa" — the cross-project review layer (frame 11b), unfiltered.
 *
 * NOT the same thing as `/projects/:id/qa`, which is the exploratory QA-check
 * agent and its reports. This screen is about `review_comments`: the findings
 * reviewers file, the verdicts they reach and the checklist they follow.
 *
 * Wrapped in `TicketOverlayProvider` exactly like `app/page.tsx`, so "Diff" and
 * every ticket click open the real ticket overlay rather than navigating away
 * from the arbitration the user is in the middle of.
 */
export default function QaPage() {
  return (
    <TicketOverlayProvider>
      <QaScreen />
    </TicketOverlayProvider>
  );
}
