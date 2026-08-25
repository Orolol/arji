import type { PullRequestCiFailureEvidence } from "@/lib/github/pull-requests";
export {
  CI_AUTOFIX_ATTEMPT_PREFIX,
  ciAutofixAttemptId,
  parseCiAutofixPayload,
  type CiAutofixPayload,
} from "@/lib/routines/ci-autofix-shared";

export interface CiAutofixRequest {
  projectId: string;
  epicId: string;
  prNumber: number;
  headSha: string;
  failures: PullRequestCiFailureEvidence[];
}

export type CiAutofixLaunchResult =
  | { status: "launched"; sessionId: string }
  | {
      status: "skipped";
      reason: "already_attempted" | "target_busy";
      sessionId: string | null;
    };

/**
 * Dispatch through the ordinary epic-build route. That route owns worktree
 * creation, workflow transitions, the persisted session lifecycle, provider
 * resolution, monitoring events, usage capture, and the project agent queue.
 */
export async function launchCiAutofixSession(
  input: CiAutofixRequest
): Promise<CiAutofixLaunchResult> {
  const [{ NextRequest }, { POST }] = await Promise.all([
    import("next/server"),
    import("@/app/api/projects/[projectId]/epics/[epicId]/build/route"),
  ]);
  const request = new NextRequest(
    `http://localhost/api/projects/${encodeURIComponent(
      input.projectId
    )}/epics/${encodeURIComponent(input.epicId)}/build`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipeline: false,
        ciAutofix: {
          prNumber: input.prNumber,
          headSha: input.headSha,
          failures: input.failures,
        },
      }),
    }
  );
  const response = await POST(request, {
    params: Promise.resolve({
      projectId: input.projectId,
      epicId: input.epicId,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    data?: {
      sessionId?: string;
      activeSessionId?: string;
      ciAutofix?: {
        launched?: boolean;
        reason?: "already_attempted";
      };
    };
  };

  if (response.status === 409 && payload.code === "AGENT_ALREADY_RUNNING") {
    return {
      status: "skipped",
      reason: "target_busy",
      sessionId: payload.data?.activeSessionId ?? null,
    };
  }
  if (!response.ok || payload.error) {
    throw new Error(payload.error || "Failed to start the CI autofix session");
  }

  const sessionId = payload.data?.sessionId ?? null;
  if (payload.data?.ciAutofix?.launched === false) {
    return { status: "skipped", reason: "already_attempted", sessionId };
  }
  if (!sessionId) {
    throw new Error("CI autofix started without a session id");
  }
  return { status: "launched", sessionId };
}
