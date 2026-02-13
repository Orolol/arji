export interface DashboardProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  gitRepoPath: string | null;
  githubOwnerRepo: string | null;
  imported: number;
  createdAt: string;
  updatedAt: string;
  epicCount: number;
  epicsDone: number;
  activeAgents: number;
}

export type ProjectFilter = "all" | "active" | "archived";
