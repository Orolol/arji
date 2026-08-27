"use client";

import { useParams } from "next/navigation";
import { RoutinesSettings } from "@/components/routines/RoutinesSettings";
import { McpServersSection } from "@/components/settings/McpServersSection";

export default function ProjectSettingsPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  return (
    <div className="space-y-4">
      <RoutinesSettings projectId={projectId} />
      {/* Project-scoped MCP servers, plus the globals this project inherits. */}
      <McpServersSection projectId={projectId} />
    </div>
  );
}
