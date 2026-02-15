"use client";

import { useProjects } from "@/hooks/useProjects";
import { ProjectCard } from "./ProjectCard";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus, FolderDown, AlertCircle, RefreshCw } from "lucide-react";
import type { ProjectFilter } from "@/lib/types/dashboard";

const FILTERS: { value: ProjectFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

export function ProjectGrid() {
  const { projects, loading, error, filter, setFilter, refresh } = useProjects();

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">Projects</h1>
          <div className="flex gap-1 ml-4">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  filter === f.value
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <Link href="/projects/import">
            <Button variant="outline" size="sm">
              <FolderDown className="h-4 w-4 mr-1" />
              Import
            </Button>
          </Link>
          <Link href="/projects/new">
            <Button size="sm">
              <Plus className="h-4 w-4 mr-1" />
              New Project
            </Button>
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 rounded-lg bg-muted/50 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="text-center py-16">
          <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-3" />
          <p className="text-destructive mb-4">{error}</p>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Retry
          </Button>
        </div>
      ) : projects.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-muted-foreground mb-4">No projects yet</p>
          <div className="flex gap-2 justify-center">
            <Link href="/projects/import">
              <Button variant="outline">
                <FolderDown className="h-4 w-4 mr-1" />
                Import Existing
              </Button>
            </Link>
            <Link href="/projects/new">
              <Button>
                <Plus className="h-4 w-4 mr-1" />
                Create New
              </Button>
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}
