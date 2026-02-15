"use client";

import { useState, useEffect, useCallback } from "react";
import type { DashboardProject, ProjectFilter } from "@/lib/types/dashboard";

export function useProjects() {
  const [projects, setProjects] = useState<DashboardProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ProjectFilter>("all");

  const loadProjects = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) {
        setError(`Failed to load projects (${res.status})`);
        setProjects([]);
        return;
      }
      const data = await res.json();
      setProjects(data.data || []);
    } catch {
      setError("Failed to load projects");
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const filtered = projects.filter((p) => {
    if (filter === "active") return p.status !== "archived";
    if (filter === "archived") return p.status === "archived";
    return true;
  });

  return {
    projects: filtered,
    allProjects: projects,
    loading,
    error,
    filter,
    setFilter,
    refresh: loadProjects,
  };
}
