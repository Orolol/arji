"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Upload } from "lucide-react";

import { BandHeader, Mono, QuietLink, StrataBand } from "@/components/piscine";
import { formatDocumentMention } from "@/lib/documents/mention-format";
import { cn } from "@/lib/utils";

/** The uploaded-document row as `GET /documents` returns it (a raw table row). */
export interface DocsCardDocument {
  id: string;
  originalFilename: string;
  kind: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

interface DocsCardProps {
  projectId: string;
  /**
   * Seeds the list and SKIPS the mount fetch — the tests render the card with
   * a fixed roster. Production omits it and always fetches.
   */
  initialDocuments?: DocsCardDocument[];
  className?: string;
}

/** The frame shows three rows; six is the point where the rail gets tall. */
const MAX_VISIBLE = 6;

const PLAIN_TEXT_MIME = new Set(["text/markdown", "text/plain"]);

/**
 * The suffix's two strings, resolved by the caller from the `Spec` namespace —
 * the same shape `formatSaveState` takes in `spec-format.ts`, and for the same
 * reason: this is a pure derivation, so it cannot call a hook and the copy
 * travels in rather than being imported.
 */
export interface DocsSuffixCopy {
  /** `(kilobytes) => t("docs.suffix.size", { kilobytes })` */
  size: (kilobytes: number) => string;
  /** `t("docs.suffix.converted")` */
  converted: string;
}

/**
 * The `· 4 KB` / `· converted` suffix — DERIVED, never stored.
 *
 * - a positive `sizeBytes` prints kilobytes (rounded up to 1, because a
 *   200-byte doc is a document, and `· 0 KB` is a house-rule violation);
 * - no size + a converted text document (its mime type is neither markdown
 *   nor plain text, so it came through `convertToMarkdown`) prints
 *   `converted`, which is the honest answer for a scan-imported row whose
 *   byte size we never recorded;
 * - anything else prints NOTHING. Never a zero.
 */
export function documentSuffix(
  doc: DocsCardDocument,
  copy: DocsSuffixCopy,
): string | null {
  if (typeof doc.sizeBytes === "number" && doc.sizeBytes > 0) {
    return ` ${copy.size(Math.max(1, Math.round(doc.sizeBytes / 1024)))}`;
  }
  if (
    doc.kind === "text" &&
    doc.mimeType &&
    !PLAIN_TEXT_MIME.has(doc.mimeType)
  ) {
    return ` ${copy.converted}`;
  }
  return null;
}

/**
 * DOCS — the white band-shaped card closing frame 8b's right rail.
 *
 * A bare list of the project's uploaded documents by their `@mention` name,
 * plus the drop zone that adds one. Rows are deliberately non-interactive and
 * carry no delete affordance: the frame draws none, and deletion belongs to
 * the documents page (which this packet does not own).
 *
 * The drop zone is an HTML5 file target, NOT a dnd-kit sortable — dnd-kit is
 * leaving the project and this is not it.
 */
export function DocsCard({ projectId, initialDocuments, className }: DocsCardProps) {
  const t = useTranslations("Spec");
  const [documents, setDocuments] = useState<DocsCardDocument[]>(
    initialDocuments ?? [],
  );
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(() => {
    if (!projectId) return;
    fetch(`/api/projects/${projectId}/documents`)
      .then(async (res) => (res.ok ? await res.json().catch(() => null) : null))
      .then((json) => {
        // The route returns `{ data: Document[] }`; anything else is a
        // transient shape we simply do not render.
        if (json && Array.isArray(json.data)) {
          setDocuments(json.data as DocsCardDocument[]);
        }
      })
      .catch(() => {});
  }, [projectId]);

  const seeded = initialDocuments !== undefined;
  useEffect(() => {
    if (seeded) return;
    load();
  }, [load, seeded]);

  /**
   * Sequential upload, stopping at the first failure and surfacing the
   * server's own message — in particular the 409 for a duplicate filename,
   * which is the common case when the same file is dropped twice. No retry,
   * no auto-rename.
   */
  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      setUploading(true);
      setError(null);
      try {
        for (const file of list) {
          const body = new FormData();
          body.append("file", file);
          const res = await fetch(`/api/projects/${projectId}/documents`, {
            method: "POST",
            body,
          });
          const json = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) {
            setError(
              json.error || t("docs.errors.importFile", { name: file.name }),
            );
            return;
          }
        }
        load();
      } catch {
        setError(t("docs.errors.import"));
      } finally {
        setUploading(false);
      }
    },
    [projectId, load, t],
  );

  const visible = documents.slice(0, MAX_VISIBLE);
  const overflow = documents.length - visible.length;

  return (
    // `rail` gives the 16px horizontal padding; the frame's 14px vertical is
    // 1px off the preset, so it is overridden here rather than in the primitive.
    <StrataBand
      stratum="card"
      density="rail"
      gap={8}
      className={`py-[14px] ${className ?? ""}`}
    >
      <BandHeader
        stratum="neutral"
        label={t("docs.label")}
        labelSize={12}
        standalone
      />

      {visible.map((doc) => {
        const suffix = documentSuffix(doc, {
          size: (kilobytes) => t("docs.suffix.size", { kilobytes }),
          converted: t("docs.suffix.converted"),
        });
        return (
          <div
            key={doc.id}
            data-testid="docs-card-row"
            title={doc.originalFilename}
            className="min-w-0"
          >
            <Mono size={11.5} tone="ink" clamp={1}>
              {formatDocumentMention(doc.originalFilename)}
              {suffix ? (
                <span className="text-muted-foreground">{suffix}</span>
              ) : null}
            </Mono>
          </div>
        );
      })}

      {overflow > 0 ? (
        <QuietLink
          tone="muted"
          size={11.5}
          href={`/projects/${projectId}/documents`}
        >
          {t("docs.more", { count: overflow })}
        </QuietLink>
      ) : null}

      <div
        data-testid="docs-drop-zone"
        role="button"
        tabIndex={0}
        aria-label={t("docs.dropZone")}
        aria-busy={uploading || undefined}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer?.files?.length) {
            void handleFiles(event.dataTransfer.files);
          }
        }}
        className={cn(
          "flex cursor-pointer items-center gap-[7px] rounded-[10px]",
          "border-[1.5px] border-dashed bg-transparent px-[11px] py-[9px]",
          "text-[12px] font-normal outline-none",
          "transition-colors duration-150 motion-reduce:transition-none",
          "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
          // No shadow and no lift on drag-over — only the border and the label
          // change tone. House rule 7.
          dragging
            ? "border-action-outline text-foreground"
            : "border-border-strong text-muted-foreground",
        )}
      >
        <Upload size={13} aria-hidden="true" />
        {t("docs.dropZone")}
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        data-testid="docs-file-input"
        onChange={(event) => {
          if (event.target.files?.length) {
            void handleFiles(event.target.files);
          }
          event.target.value = "";
        }}
      />

      {error ? (
        <p
          data-testid="docs-upload-error"
          className="text-[11.5px] text-destructive"
        >
          {error}
        </p>
      ) : null}
    </StrataBand>
  );
}
