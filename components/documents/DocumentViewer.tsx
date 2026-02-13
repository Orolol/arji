"use client";

interface DocumentViewerProps {
  kind: "text" | "image";
  markdownContent: string | null;
  imagePath: string | null;
}

export function DocumentViewer({
  kind,
  markdownContent,
  imagePath,
}: DocumentViewerProps) {
  if (kind === "image") {
    return (
      <div className="border border-border rounded-lg p-4 max-h-[600px] overflow-auto">
        <p className="text-sm font-medium mb-2">Image Document</p>
        <p className="text-xs text-muted-foreground break-all">
          Filesystem path: {imagePath || "(missing path)"}
        </p>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-lg p-4 max-h-[600px] overflow-auto">
      <div className="prose prose-sm prose-invert max-w-none whitespace-pre-wrap">
        {markdownContent || ""}
      </div>
    </div>
  );
}
