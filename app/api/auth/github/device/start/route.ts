import { NextRequest, NextResponse } from "next/server";
import {
  DeviceFlowError,
  startDeviceFlow,
} from "@/lib/github/device-flow";
import {
  rememberDeviceFlow,
  toClientDeviceFlow,
} from "@/lib/github/device-flow-store";
import { startGitHubDeviceFlowSchema } from "@/lib/validation/schemas";
import { validateOptionalBody, isValidationError } from "@/lib/validation/validate";

/**
 * POST /api/auth/github/device/start — begin "Se connecter avec GitHub".
 *
 * Asks GitHub for a device/user code pair, keeps the device code in this
 * process, and hands the browser the half a human needs: the 8-character code
 * to type, where to type it, and an opaque handle to poll with.
 *
 * Takes no input. Scopes are fixed in `lib/github/device-flow.ts` rather than
 * accepted from the request — what Arij asks for on the user's GitHub account
 * is not a client's decision.
 *
 * Starting a flow SUPERSEDES any flow already in progress: the store holds one
 * slot, and an abandoned sign-in must not block the next one for fifteen
 * minutes. A poll on the superseded handle 404s, which is the client's cue to
 * start over.
 *
 * Failure shape: `{ error, code }`. Every refusal here is a DeviceFlowError
 * with a machine code — including `CLIENT_ID_NOT_CONFIGURED`, which is the
 * expected state until the "Arij" OAuth App is registered and is what tells
 * the UI to fall back to pasting a PAT by hand. None of these are 500s; the
 * only 500 left is a genuinely unexpected throw.
 */
export async function POST(request: NextRequest) {
  const validated = await validateOptionalBody(
    startGitHubDeviceFlowSchema,
    request
  );
  if (isValidationError(validated)) return validated;

  try {
    const start = await startDeviceFlow();
    const record = rememberDeviceFlow(start);

    // toClientDeviceFlow is the projection that drops `deviceCode`. Returning
    // the record itself would leak the secret half of the pair to the browser.
    return NextResponse.json({ data: toClientDeviceFlow(record) });
  } catch (error) {
    if (error instanceof DeviceFlowError) {
      // 503 for "GitHub is not answering", 400 for everything else: an
      // unconfigured client ID or a rejected OAuth App is a state the user
      // must act on, not a transient failure worth retrying.
      const status = error.code === "GITHUB_UNREACHABLE" ? 503 : 400;
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status }
      );
    }

    return NextResponse.json(
      {
        error: "Could not start the GitHub sign-in. Try again.",
        code: "DEVICE_FLOW_START_FAILED",
      },
      { status: 500 }
    );
  }
}
