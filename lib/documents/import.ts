import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { documents } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { convertToMarkdown } from "@/lib/converters";
import { DOCUMENT_SCAN_EXTENSIONS } from "./scan-constants";

/** Per-request cap: the batch runs conversions synchronously inside one request. */
export const DOCUMENT_IMPORT_MAX_FILES = 100;

/** Same cap as the manual upload route — scanned docs feed the same prompts. */
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * Extension → mime mapping for the converter. `.doc` is deliberately absent:
 * the converter has no legacy-Word reader, so those files are skipped with an
 * explicit reason instead of a cryptic "Unsupported file type" failure.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

export interface SkippedImportFile {
  relativePath: string;
  /** Human-readable (French, UI-facing) reason the file was not imported. */
  reason: string;
}

export interface ScannedDocumentImportResult {
  imported: Array<typeof documents.$inferSelect>;
  skipped: SkippedImportFile[];
}

/**
 * Imports a batch of scan results (repo-relative paths from
 * scanProjectDocuments) as project documents.
 *
 * One bad file never aborts the batch: every failure is collected into
 * `skipped` with a reason, mirroring the scanner's per-entry error posture.
 * Dedup is case-insensitive on the basename, matching the upload route's
 * uniqueness rule (and the documents_project_filename_unique index).
 */
export async function importScannedDocuments(
  root: string,
  projectId: string,
  relativePaths: string[]
): Promise<ScannedDocumentImportResult> {
  const imported: ScannedDocumentImportResult["imported"] = [];
  const skipped: SkippedImportFile[] = [];
  const rootResolved = path.resolve(root);
  const batchSeen = new Set<string>();

  for (const relativePath of relativePaths) {
    const skip = (reason: string) => skipped.push({ relativePath, reason });

    if (typeof relativePath !== "string" || relativePath.trim() === "") {
      continue; // nothing meaningful to report a skip for
    }

    // Client-echoed input is treated as untrusted: normalize separators and
    // refuse anything that is absolute or escapes the scanned root.
    const rel = relativePath.replace(/\\/g, "/");
    if (path.isAbsolute(rel) || rel.split("/").includes("..")) {
      skip("Chemin invalide.");
      continue;
    }
    const absolutePath = path.resolve(rootResolved, rel);
    if (!absolutePath.startsWith(rootResolved + path.sep)) {
      skip("Chemin invalide.");
      continue;
    }

    const extension = path.extname(rel).toLowerCase();
    if (!DOCUMENT_SCAN_EXTENSIONS[extension]) {
      skip("Type de fichier non pris en charge.");
      continue;
    }
    if (extension === ".doc") {
      skip(
        "Format .doc non pris en charge — convertissez le fichier en .docx."
      );
      continue;
    }
    const mimeType = MIME_BY_EXTENSION[extension] ?? null;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      skip("Fichier introuvable sur le disque.");
      continue;
    }
    if (!stat.isFile()) {
      skip("Chemin invalide.");
      continue;
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      skip(
        `Fichier trop volumineux (${(stat.size / 1024 / 1024).toFixed(1)} Mo, max 20 Mo).`
      );
      continue;
    }

    const fileName = path.basename(rel);
    const lowerName = fileName.toLowerCase();
    if (batchSeen.has(lowerName)) {
      skip(`« ${fileName} » est déjà importé dans cette demande.`);
      continue;
    }
    batchSeen.add(lowerName);

    const duplicate = db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.projectId, projectId),
          sql`LOWER(${documents.originalFilename}) = LOWER(${fileName})`
        )
      )
      .get();
    if (duplicate) {
      skip("Déjà importé.");
      continue;
    }

    let markdownContent: string;
    try {
      const buffer = fs.readFileSync(absolutePath);
      markdownContent = await convertToMarkdown(buffer, mimeType, fileName);
    } catch (error) {
      skip(
        `Échec de la conversion : ${
          error instanceof Error ? error.message : "Erreur inconnue"
        }`
      );
      continue;
    }

    const id = createId();
    const now = new Date().toISOString();
    try {
      db.insert(documents)
        .values({
          id,
          projectId,
          originalFilename: fileName,
          kind: "text",
          markdownContent,
          imagePath: null,
          mimeType,
          sizeBytes: stat.size,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch {
      // Lost a race against the case-insensitive unique index (e.g. a manual
      // upload landing between the duplicate check and the insert).
      skip("Déjà importé.");
      continue;
    }

    imported.push({
      id,
      projectId,
      originalFilename: fileName,
      kind: "text",
      markdownContent,
      imagePath: null,
      mimeType,
      sizeBytes: stat.size,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { imported, skipped };
}
