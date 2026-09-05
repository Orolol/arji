import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { GITHUB_PAT_SETTING_KEY, validateGitHubToken } from "@/lib/github/client";
import { pollDeviceFlow } from "@/lib/github/device-flow";
import {
  forgetDeviceFlow,
  resolveDeviceFlow,
  setDeviceFlowInterval,
} from "@/lib/github/device-flow-store";
import {
  GITHUB_OAUTH_META_SETTING_KEY,
  type GitHubOAuthMeta,
} from "@/lib/github/oauth-meta";
import { pollGitHubDeviceFlowSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";

/**
 * Poll error codes that mean "GitHub did not give us a usable answer", as
 * opposed to "GitHub refused this flow".
 *
 * The distinction decides whether the flow survives. A network blip while the
 * user is still typing their code must not destroy a device code that is good
 * for another fourteen minutes — the client backs off and tries again. A
 * refusal (`incorrect_device_code`, `unauthorized_client`, an unconfigured
 * client ID, a code GitHub adds later) is terminal: the flow is dead and
 * polling it again would only produce the same refusal forever.
 *
 * The values are lowercase because `pollDeviceFlow` lowercases the transport's
 * own codes to sit alongside GitHub's, which are lowercase by protocol.
 */
const RETRYABLE_POLL_ERROR_CODES = new Set([
  "github_unreachable",
  "malformed_response",
  "unexpected_error",
]);

/**
 * Persist the token and its provenance in one transaction.
 *
 * The token goes to the EXISTING `github_pat` key, unchanged in shape — that
 * is the whole reason clone, PR, issue and release code needs no edit for this
 * epic. `github_oauth_meta` is the new, secret-free sibling that records who
 * the token belongs to and where it came from.
 *
 * One transaction because a token without its meta reads in Settings as a
 * hand-pasted PAT, and meta without its token claims a connection that cannot
 * make a single API call. Neither half is usable alone.
 */
function persistDeviceFlowToken(token: string, meta: GitHubOAuthMeta): void {
  const now = new Date().toISOString();

  const rows: Array<{ key: string; value: unknown }> = [
    { key: GITHUB_PAT_SETTING_KEY, value: token },
    { key: GITHUB_OAUTH_META_SETTING_KEY, value: meta },
  ];

  db.transaction((tx) => {
    for (const row of rows) {
      const value = JSON.stringify(row.value);
      tx.insert(settings)
        .values({ key: row.key, value, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: now },
        })
        .run();
    }
  });
}

/**
 * POST /api/auth/github/device/poll `{ handle }` — one poll tick.
 *
 * One tick per request, deliberately: the browser owns the cadence and the
 * user's ability to give up, and a server-side loop would hold a request open
 * for up to fifteen minutes for no gain. The response carries the `interval`
 * to wait before the next call, raised when GitHub answers `slow_down`.
 *
 * The handle is the browser's only reference to the flow; the device code it
 * stands for stays in `lib/github/device-flow-store.ts` and is never
 * serialised. The access token is not serialised either — on success the
 * response says who Arij connected as, not what it connected with.
 *
 * Statuses:
 * - 200 `{ state: "pending" | "slow_down", interval }` — keep going.
 * - 200 `{ state: "success", login, scopes, obtainedAt, tokenSource }` — done;
 *   the token is now in settings and the flow is gone.
 * - 404 `DEVICE_FLOW_NOT_FOUND` — unknown handle, or one superseded by a newer
 *   `start`. Start again.
 * - 410 `DEVICE_FLOW_EXPIRED` — the code timed out, ours or GitHub's.
 * - 403 `DEVICE_FLOW_DENIED` — the user refused on github.com.
 * - 503 — GitHub is unreachable; the flow is still alive, retry.
 * - 502 — GitHub refused the flow, or handed back a token it will not
 *   authenticate. Terminal.
 */
export async function POST(request: NextRequest) {
  const validated = await validateBody(pollGitHubDeviceFlowSchema, request);
  if (isValidationError(validated)) return validated;

  const { handle } = validated.data;
  const lookup = resolveDeviceFlow(handle);

  if (lookup.state === "expired") {
    return NextResponse.json(
      {
        error: "This GitHub sign-in expired. Start it again.",
        code: "DEVICE_FLOW_EXPIRED",
      },
      { status: 410 }
    );
  }

  if (lookup.state === "unknown") {
    return NextResponse.json(
      {
        error: "No GitHub sign-in is in progress. Start it again.",
        code: "DEVICE_FLOW_NOT_FOUND",
      },
      { status: 404 }
    );
  }

  const { record } = lookup;
  const result = await pollDeviceFlow(record.deviceCode, record.interval);

  switch (result.state) {
    case "pending":
      return NextResponse.json({
        data: { state: "pending", interval: record.interval },
      });

    case "slow_down":
      // GitHub is telling us we polled too fast. Persist the new cadence so
      // the NEXT tick is measured against it — reporting it to the client
      // without storing it would re-offend as soon as the flow is re-read.
      setDeviceFlowInterval(handle, result.interval);
      return NextResponse.json({
        data: { state: "slow_down", interval: result.interval },
      });

    case "expired":
      forgetDeviceFlow(handle);
      return NextResponse.json(
        {
          error: "This GitHub sign-in expired. Start it again.",
          code: "DEVICE_FLOW_EXPIRED",
        },
        { status: 410 }
      );

    case "denied":
      forgetDeviceFlow(handle);
      return NextResponse.json(
        {
          error: "The GitHub sign-in was refused. Start it again to retry.",
          code: "DEVICE_FLOW_DENIED",
        },
        { status: 403 }
      );

    case "error": {
      const retryable = RETRYABLE_POLL_ERROR_CODES.has(result.code);
      if (!retryable) forgetDeviceFlow(handle);
      return NextResponse.json(
        { error: result.message, code: result.code.toUpperCase() },
        { status: retryable ? 503 : 502 }
      );
    }

    case "success": {
      // Resolve the identity BEFORE storing anything: `login` is the whole
      // point of the meta key, and a token Arij cannot attribute to an account
      // is one Settings could only describe as a mystery. Refusing here costs
      // the user one more click; the manual-PAT field is still there.
      const identity = await validateGitHubToken(result.accessToken);
      const login = identity.login?.trim() ?? "";

      if (!identity.valid || !login) {
        forgetDeviceFlow(handle);
        return NextResponse.json(
          {
            error:
              identity.error ??
              "GitHub authorized the sign-in but would not confirm the account. Try again.",
            code: "TOKEN_VALIDATION_FAILED",
          },
          { status: 502 }
        );
      }

      const meta: GitHubOAuthMeta = {
        login,
        // The scopes GitHub GRANTED, which can be narrower than the ones asked
        // for — an org with OAuth App restrictions is the usual reason.
        scopes: result.scopes,
        obtainedAt: new Date().toISOString(),
        tokenSource: "oauth_device",
      };

      persistDeviceFlowToken(result.accessToken, meta);
      forgetDeviceFlow(handle);

      // `meta` and nothing else. The token stays where it was written.
      return NextResponse.json({ data: { state: "success", ...meta } });
    }
  }
}
