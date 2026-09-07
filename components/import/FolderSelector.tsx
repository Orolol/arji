"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FolderOpen } from "lucide-react";

interface FolderSelectorProps {
  onAnalyze: (path: string) => void;
}

export function FolderSelector({ onAnalyze }: FolderSelectorProps) {
  const [path, setPath] = useState("");
  const t = useTranslations("Import");

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">{t("folder.help")}</p>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t("folder.pathPlaceholder")}
            className="pl-10"
          />
        </div>
        <Button onClick={() => onAnalyze(path)} disabled={!path.trim()}>
          {t("folder.analyze")}
        </Button>
      </div>
    </div>
  );
}
