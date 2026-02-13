"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type ProviderType = "claude-code" | "codex" | "gemini-cli";

interface ProviderSelectProps {
  value: ProviderType;
  onChange: (value: ProviderType) => void;
  codexAvailable: boolean;
  /** Whether the codex binary is on PATH (even if not logged in). */
  codexInstalled?: boolean;
  disabled?: boolean;
  className?: string;
}

export function ProviderSelect({
  value,
  onChange,
  codexAvailable,
  codexInstalled = false,
  disabled = false,
  className,
}: ProviderSelectProps) {
  const tooltipMessage =
    codexInstalled && !codexAvailable
      ? "Codex CLI not authenticated. Run: codex login"
      : "Codex CLI not found. Install it with: npm i -g @openai/codex";

  return (
    <TooltipProvider>
      <Select
        value={value}
        onValueChange={(v) => onChange(v as ProviderType)}
        disabled={disabled}
      >
        <SelectTrigger className={className ?? "w-40 h-7 text-xs"}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="claude-code">Claude Code</SelectItem>
          <SelectItem value="gemini-cli">Gemini CLI</SelectItem>
          {codexAvailable ? (
            <SelectItem value="codex">Codex</SelectItem>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <SelectItem value="codex" disabled>
                    Codex
                  </SelectItem>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                {tooltipMessage}
              </TooltipContent>
            </Tooltip>
          )}
        </SelectContent>
      </Select>
    </TooltipProvider>
  );
}
