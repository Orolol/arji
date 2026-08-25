/**
 * Shared shape of the import preview, as produced by
 * POST /api/projects/import (either the parsed `arji.json` or Claude's
 * analysis output) and consumed by both the import page and
 * `ImportPreview`. Declared once so a new arji.json field is added in one
 * place — the page's copy used to diverge from the preview's (extra
 * `status`/`spec`/`priority`/`position` fields).
 */
export interface ImportData {
  project: {
    name: string;
    description: string;
    status?: string;
    spec?: string | null;
    stack?: string;
    architecture?: string;
  };
  epics: Array<{
    title: string;
    description?: string;
    status: string;
    priority?: number;
    position?: number;
    branchName?: string | null;
    confidence?: number;
    evidence?: string;
    user_stories: Array<{
      title: string;
      description?: string;
      acceptance_criteria?: string;
      status: string;
    }>;
  }>;
}