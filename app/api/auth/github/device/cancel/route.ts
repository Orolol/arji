import { NextRequest, NextResponse } from "next/server";
import { forgetDeviceFlow } from "@/lib/github/device-flow-store";
import { cancelGitHubDeviceFlowSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";

/**
 * POST /api/auth/github/device/cancel `{ handle }` — abandon a sign-in.
 *
 * The client stopping its own timers is not the same as the flow being over.
 * The server still holds a device code, and a poll already in flight when the
 * user clicked away will come back holding a real access token — which the
 * poll route would have written to `settings`, reconnecting an account the
 * user had just decided not to connect. This is what closes that window: the
 * slot is dropped here, so the claim the poll route makes before persisting
 * fails and the token is discarded unwritten.
 *
 * Idempotent, and 200 either way. "There was nothing to cancel" is the same
 * outcome as "cancelled" from the caller's side — a page that reloaded, a
 * server that restarted and a double-clicked button all land here, and none
 * of them is an error worth showing anyone.
 *
 * Handle-scoped: cancelling flow A must not touch flow B. Broad invalidation
 * belongs to `abortDeviceFlow`, which `PATCH /api/settings` uses when the user
 * settles the credential question by hand.
 */
export async function POST(request: NextRequest) {
  const validated = await validateBody(cancelGitHubDeviceFlowSchema, request);
  if (isValidationError(validated)) return validated;

  forgetDeviceFlow(validated.data.handle);

  return NextResponse.json({ data: { cancelled: true } });
}
