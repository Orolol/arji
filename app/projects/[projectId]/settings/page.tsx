"use client";

import { useParams } from "next/navigation";
import { RoutinesSettings } from "@/components/routines/RoutinesSettings";

export default function ProjectSettingsPage() {
  const params = useParams();
  return <RoutinesSettings projectId={params.projectId as string} />;
}
