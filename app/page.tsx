import { NowDesk } from "@/components/desk/NowDesk";
import { TicketOverlayProvider } from "@/components/ticket/TicketOverlayProvider";

/**
 * "/" — the control desk, unfiltered.
 *
 * This route replaces the dashboard project grid. There is no left rail here:
 * `components/layout/Sidebar.tsx` returns null on "/", so the desk is
 * full-bleed and every pixel of reclaimed height goes to the strata. The
 * project grid's job — "which projects exist, which are alive" — is now the
 * header's project rail.
 */
export default function DeskPage() {
  return (
    <TicketOverlayProvider>
      <NowDesk />
    </TicketOverlayProvider>
  );
}
