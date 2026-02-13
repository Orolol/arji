import {
  AGENT_ALREADY_RUNNING_CODE,
  isAgentAlreadyRunningPayload,
} from "@/lib/agents/concurrency-shared";

export interface AgentRequestError extends Error {
  code?: string;
  activeSessionId?: string;
  sessionUrl?: string;
}

export function toAgentRequestError(
  payload: unknown,
  fallbackMessage = "Agent request failed"
): AgentRequestError {
  const message =
    payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
      ? ((payload as { error: string }).error || fallbackMessage)
      : fallbackMessage;

  const err = new Error(message) as AgentRequestError;

  if (isAgentAlreadyRunningPayload(payload)) {
    err.code = AGENT_ALREADY_RUNNING_CODE;
    err.activeSessionId = payload.data.activeSessionId;
    err.sessionUrl = payload.data.sessionUrl;
  }

  return err;
}

export function isAgentAlreadyRunningError(
  value: unknown
): value is AgentRequestError {
  if (!value || typeof value !== "object") return false;
  const err = value as AgentRequestError;
  return (
    err.code === AGENT_ALREADY_RUNNING_CODE &&
    typeof err.activeSessionId === "string"
  );
}
