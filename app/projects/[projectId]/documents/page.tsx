"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { UploadZone } from "@/components/documents/UploadZone";
import { DocumentViewer } from "@/components/documents/DocumentViewer";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";

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
    const docs = (data.data || []) as Doc[];
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
    <div className="p-6">
      <h2 className="text-xl font-bold mb-4">Documents</h2>
      <UploadZone projectId={projectId} onUploaded={handleUploaded} />
      {error && <p className="text-sm text-destructive mt-3">{error}</p>}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-2">
          {documents.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No documents uploaded yet
            </p>
          )}
          {documents.map((doc) => (
            <div
              key={doc.id}
              className={`w-full p-3 rounded-md border transition-colors ${
                selectedDoc?.id === doc.id
                  ? "border-primary bg-accent"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              <button
                onClick={() => setSelectedDoc(doc)}
                className="w-full text-left"
              >
                <div className="font-medium text-sm">{doc.originalFilename}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  type: {doc.kind} | mime: {doc.mimeType || "unknown"} | size: {formatSize(doc.sizeBytes)}
                </div>
                <div className="text-[11px] text-muted-foreground/80 mt-1">
                  id: {doc.id}
                </div>
              </button>
              <div className="mt-2 flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-destructive"
                  onClick={() => handleDelete(doc)}
                  disabled={deletingId === doc.id}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  {deletingId === doc.id ? "Deleting..." : "Delete"}
                </Button>
              </div>
            </div>
          ))}
        </div>
        {selectedDoc && (
          <div>
            <DocumentViewer
              kind={selectedDoc.kind}
              markdownContent={selectedDoc.markdownContent}
              imagePath={selectedDoc.imagePath}
            />
          </div>
        )}
      </div>
    </div>
  );
}
