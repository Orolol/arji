"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface LogViewerProps {
  content: string;
  maxHeight?: string;
  label?: string;
  className?: string;
}

export function LogViewer({
  content,
  maxHeight = "300px",
  label,
  className,
}: LogViewerProps) {
  const [copied, setCopied] = useState(false);

  // Try to pretty-print JSON
  let displayContent = content;
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      displayContent = JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // Not valid JSON, use as-is
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div
      className={cn(
        "relative rounded-md border border-border bg-muted/30",
        className,
      )}
      data-testid="log-viewer"
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        {label ? (
          <span className="text-xs font-medium text-muted-foreground">
            {label}
          </span>
        ) : (
          <span />
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6"
          onClick={handleCopy}
          title={copied ? "Copied!" : "Copy to clipboard"}
          data-testid="copy-button"
        >
          {copied ? (
            <Check className="h-3 w-3" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </Button>
      </div>
      <div
        className="overflow-auto font-mono text-xs leading-relaxed p-3 whitespace-pre-wrap break-words"
        style={{ maxHeight }}
        data-testid="log-viewer-content"
      >
        {displayContent}
      </div>
    </div>
  );
}
