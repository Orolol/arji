"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { UploadZone } from "@/components/documents/UploadZone";
import { ScanProjectDialog } from "@/components/documents/ScanProjectDialog";
import { DocumentViewer } from "@/components/documents/DocumentViewer";
import { ProjectMemoryCard } from "@/components/documents/ProjectMemoryCard";
import { Button } from "@/components/ui/button";
import { FileText, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/utils/format-date";
import { isInternalMemoryDocKind } from "@/lib/documents/memory-constants";

interface Doc {
  id: string;
  originalFilename: string;
  kind: "text" | "image";
  markdownContent: string | null;
  imagePath: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
}

export default function DocumentsPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const [documents, setDocuments] = useState<Doc[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Doc | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadDocs() {
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/documents`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Failed to load documents.");
      return;
    }
    // The learned project memory and its pre-dream snapshot live in the same
    // table but have their own editor card — keep them out of the uploads list
    // so they cannot be casually deleted like a reference document. The GET
    // route filters them too; this is the same rule applied at both ends.
    const docs = (
      (data.data || []) as Array<Omit<Doc, "kind"> & { kind: string }>
    ).filter((doc) => !isInternalMemoryDocKind(doc.kind)) as Doc[];
    setDocuments(docs);
    if (selectedDoc && !docs.some((doc) => doc.id === selectedDoc.id)) {
      setSelectedDoc(null);
    }
  }

  useEffect(() => {
    loadDocs();
  }, [projectId]);

  function handleUploaded() {
    loadDocs();
  }

  async function handleDelete(doc: Doc) {
    setDeletingId(doc.id);
    setError(null);

    try {
      const res = await fetch(
        `/api/projects/${projectId}/documents/${doc.id}`,
        { method: "DELETE" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed to delete "${doc.originalFilename}".`);
        return;
      }

      if (selectedDoc?.id === doc.id) {
        setSelectedDoc(null);
      }
      await loadDocs();
    } finally {
      setDeletingId(null);
    }
  }

  function formatSize(bytes: number | null): string {
    if (typeof bytes !== "number" || Number.isNaN(bytes)) return "n/a";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-start gap-[16px] px-[26px] pb-[18px] pt-[24px]">
        <div className="flex flex-col gap-[5px]">
          <h2 className="text-[19px] font-semibold">Documents</h2>
          <p className="text-[13px] text-muted-foreground">
            What agents can cite: specs, audits, notes. Mentionable with @name
            in the chat.
          </p>
        </div>
        <div className="ml-auto">
          <ScanProjectDialog projectId={projectId} onImported={handleUploaded} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-[26px] overflow-y-auto px-[26px] pb-[26px]">
        <div className="flex min-w-0 flex-1 flex-col gap-[18px]">
          <div className="flex flex-wrap content-start gap-[16px]">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className={cn(
                  "relative flex w-[252px] max-w-full flex-col gap-[10px] rounded-[12px] border bg-card p-[16px] transition-colors",
                  selectedDoc?.id === doc.id
                    ? "border-primary"
                    : "border-border hover:border-ring/40"
                )}
              >
                <button
                  onClick={() => setSelectedDoc(doc)}
                  className="flex flex-col gap-[10px] text-left"
                >
                  <FileText className="h-[17px] w-[17px] text-meta" />
                  <span className="pr-[22px] text-[14px] font-medium leading-[1.35]">
                    {doc.originalFilename}
                  </span>
                  <span className="font-mono text-[11px] text-meta">
                    {formatSize(doc.sizeBytes)}
                    {doc.createdAt ? ` · ${timeAgo(doc.createdAt)}` : ""}
                  </span>
                </button>
                <span className="w-fit rounded-full bg-band px-[9px] py-[3px] text-[11.5px] text-muted-foreground">
                  {doc.kind}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete ${doc.originalFilename}`}
                  title={
                    deletingId === doc.id
                      ? "Deleting..."
                      : `Delete ${doc.originalFilename}`
                  }
                  className="absolute right-[10px] top-[10px] h-[26px] w-[26px] p-0 text-meta hover:text-destructive"
                  onClick={() => handleDelete(doc)}
                  disabled={deletingId === doc.id}
                >
                  <Trash2 className="h-[13px] w-[13px]" />
                </Button>
              </div>
            ))}

            <UploadZone projectId={projectId} onUploaded={handleUploaded} />
          </div>

          {documents.length === 0 && (
            <p className="text-[13px] text-muted-foreground">
              No documents uploaded yet
            </p>
          )}
          {error && <p className="text-[13px] text-destructive">{error}</p>}

          {selectedDoc && (
            <div className="flex flex-col gap-[10px]">
              <div className="flex items-center gap-[10px]">
                <span className="text-[13.5px] font-medium">
                  {selectedDoc.originalFilename}
                </span>
                <span className="font-mono text-[11px] text-meta">
                  {selectedDoc.mimeType || "unknown"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Close document preview"
                  className="ml-auto h-[26px] w-[26px] p-0 text-meta"
                  onClick={() => setSelectedDoc(null)}
                >
                  <X className="h-[14px] w-[14px]" />
                </Button>
              </div>
              <DocumentViewer
                kind={selectedDoc.kind}
                markdownContent={selectedDoc.markdownContent}
                imagePath={selectedDoc.imagePath}
              />
            </div>
          )}
        </div>

        <aside className="hidden w-[340px] flex-none flex-col gap-[16px] lg:flex">
          <ProjectMemoryCard projectId={projectId} />
          <div className="flex flex-col gap-[10px] rounded-[12px] border border-border p-[16px]">
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              Mentions
            </span>
            <span className="text-[13.5px] leading-[1.55] text-muted-foreground">
              Type{" "}
              <span className="font-mono text-[12.5px] text-foreground">
                @DOC_NAME
              </span>{" "}
              in a ticket or the chat: the document travels with the prompt.
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}
