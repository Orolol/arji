"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AgentConfigPanel } from "./AgentConfigPanel";

export function AgentConfigButton() {
  const [open, setOpen] = useState(false);
  const params = useParams();
  const projectId = typeof params?.projectId === "string" ? params.projectId : undefined;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-sidebar-accent text-sidebar-foreground transition-colors"
        title="Agent Configuration"
      >
        <SlidersHorizontal className="h-5 w-5" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-[480px] sm:max-w-[480px] p-0 flex flex-col">
          <SheetHeader className="px-4 pt-4 pb-2 shrink-0">
            <SheetTitle>Agent Configuration</SheetTitle>
          </SheetHeader>
          <div className="flex-1 min-h-0">
            <AgentConfigPanel projectId={projectId} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
