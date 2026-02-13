export const AGENT_ALREADY_RUNNING_CODE = "AGENT_ALREADY_RUNNING" as const;

export interface ActiveAgentSessionSummary {
  id: string;
  projectId: string;
  epicId: string | null;
  userStoryId: string | null;
  mode: string | null;
  provider: string | null;
  startedAt: string | null;
}

export interface AgentAlreadyRunningPayload {
  error: string;
  code: typeof AGENT_ALREADY_RUNNING_CODE;
  data: {
    activeSessionId: string;
    activeSession: ActiveAgentSessionSummary;
    sessionUrl: string;
    target:
      | {
          scope: "epic";
          projectId: string;
          epicId: string;
        }
      | {
          scope: "story";
          projectId: string;
          storyId: string;
          epicId?: string;
        };
  };
}

export function isAgentAlreadyRunningPayload(
  value: unknown
): value is AgentAlreadyRunningPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as { code?: unknown; data?: { activeSessionId?: unknown } };
  return (
    v.code === AGENT_ALREADY_RUNNING_CODE &&
    typeof v.data?.activeSessionId === "string"
  );
}
