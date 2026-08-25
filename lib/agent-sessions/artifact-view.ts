/** Client-safe shape used by the ticket review gallery. */
export interface SessionArtifactSummary {
  id: string;
  agentSessionId: string;
  epicId: string;
  caption: string;
  createdAt: string | null;
}

/** The file route accepts an opaque artifact id, never a client-supplied path. */
export function sessionArtifactUrl(
  projectId: string,
  artifactId: string
): string {
  return `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`;
}
