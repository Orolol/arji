import { describe, expect, it } from "vitest";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  IMAGE_UPLOAD_ACCEPT,
  MAX_IMAGE_UPLOAD_BYTES,
  formatImageRejections,
  imageFilesFromClipboard,
  imageFilesFromDrop,
  imageUploadRejectionReason,
  isAllowedImageMimeType,
  partitionImageFiles,
} from "@/lib/uploads/image-attachments";

function fileOfSize(name: string, type: string, size: number): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("image attachment rules", () => {
  it("pins the limits the chat upload route enforces", () => {
    // The bug modal reuses the chat pipeline; if these drift the UI would
    // accept files the server then rejects with a 400.
    expect(MAX_IMAGE_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(ALLOWED_IMAGE_MIME_TYPES).toEqual([
      "image/png",
      "image/jpg",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ]);
    expect(IMAGE_UPLOAD_ACCEPT).toBe(
      "image/png,image/jpg,image/jpeg,image/gif,image/webp"
    );
  });

  it("accepts the supported image types", () => {
    for (const type of ALLOWED_IMAGE_MIME_TYPES) {
      expect(isAllowedImageMimeType(type)).toBe(true);
      expect(imageUploadRejectionReason({ type, size: 1024 })).toBeNull();
    }
  });

  it("refuses a non-image file by naming the allowed types", () => {
    const reason = imageUploadRejectionReason({ type: "application/pdf", size: 10 });
    expect(reason).toBe(
      "Unsupported file type: application/pdf. Allowed: png, jpg, jpeg, gif, webp"
    );
  });

  it("refuses an image type outside the allowed set", () => {
    expect(imageUploadRejectionReason({ type: "image/svg+xml", size: 10 })).toContain(
      "Unsupported file type: image/svg+xml"
    );
  });

  it("refuses a file over the size limit and states its size", () => {
    const reason = imageUploadRejectionReason({
      type: "image/png",
      size: 12 * 1024 * 1024,
    });
    expect(reason).toBe("File too large (12.0MB). Max: 10MB");
  });

  it("accepts a file sitting exactly on the limit", () => {
    expect(
      imageUploadRejectionReason({ type: "image/png", size: MAX_IMAGE_UPLOAD_BYTES })
    ).toBeNull();
    expect(
      imageUploadRejectionReason({
        type: "image/png",
        size: MAX_IMAGE_UPLOAD_BYTES + 1,
      })
    ).not.toBeNull();
  });

  it("splits a mixed batch into uploadable files and named rejections", () => {
    const shot = fileOfSize("shot.png", "image/png", 2048);
    const notes = fileOfSize("notes.pdf", "application/pdf", 2048);
    const huge = fileOfSize("huge.png", "image/png", 11 * 1024 * 1024);

    const { accepted, rejected } = partitionImageFiles([shot, notes, huge]);

    expect(accepted).toEqual([shot]);
    expect(rejected).toEqual([
      {
        fileName: "notes.pdf",
        reason:
          "Unsupported file type: application/pdf. Allowed: png, jpg, jpeg, gif, webp",
      },
      { fileName: "huge.png", reason: "File too large (11.0MB). Max: 10MB" },
    ]);
  });

  it("formats rejections as one line naming each file", () => {
    expect(formatImageRejections([])).toBeNull();
    expect(
      formatImageRejections([
        { fileName: "notes.pdf", reason: "Unsupported file type: application/pdf" },
        { fileName: "huge.png", reason: "File too large (11.0MB). Max: 10MB" },
      ])
    ).toBe(
      "notes.pdf: Unsupported file type: application/pdf · huge.png: File too large (11.0MB). Max: 10MB"
    );
  });

  describe("clipboard extraction", () => {
    it("renames a pasted image so it reads as a screenshot", () => {
      const pasted = new File(["data"], "image.png", { type: "image/png" });
      const files = imageFilesFromClipboard(
        { items: [{ type: "image/png", getAsFile: () => pasted }] },
        1700000000000
      );

      expect(files).toHaveLength(1);
      expect(files[0]!.name).toBe("pasted-image-1700000000000.png");
      expect(files[0]!.type).toBe("image/png");
    });

    it("gives each image of a multi-image paste its own name", () => {
      const files = imageFilesFromClipboard(
        {
          items: [
            {
              type: "image/png",
              getAsFile: () => new File(["a"], "image.png", { type: "image/png" }),
            },
            {
              type: "image/webp",
              getAsFile: () => new File(["b"], "image.webp", { type: "image/webp" }),
            },
          ],
        },
        1700000000000
      );

      expect(files.map((f) => f.name)).toEqual([
        "pasted-image-1700000000000.png",
        "pasted-image-1700000000000-2.webp",
      ]);
    });

    it("returns nothing for a text-only paste", () => {
      expect(
        imageFilesFromClipboard({
          items: [{ type: "text/plain", getAsFile: () => null }],
        })
      ).toEqual([]);
      expect(imageFilesFromClipboard(null)).toEqual([]);
      expect(imageFilesFromClipboard({})).toEqual([]);
    });

    it("falls back to clipboardData.files when no item carries a file", () => {
      const dropped = new File(["data"], "capture.png", { type: "image/png" });
      const files = imageFilesFromClipboard({ items: [], files: [dropped] }, 42);
      expect(files.map((f) => f.name)).toEqual(["pasted-image-42.png"]);
    });

    it("keeps a pasted non-image under its own name so it can be named in the error", () => {
      const report = new File(["data"], "report.pdf", { type: "application/pdf" });
      const files = imageFilesFromClipboard({
        items: [{ type: "application/pdf", getAsFile: () => report }],
      });

      expect(files.map((f) => f.name)).toEqual(["report.pdf"]);
      expect(partitionImageFiles(files).accepted).toEqual([]);
    });
  });

  describe("drop extraction", () => {
    it("reads the dropped files", () => {
      const dropped = new File(["data"], "bug.png", { type: "image/png" });
      expect(imageFilesFromDrop({ files: [dropped] })).toEqual([dropped]);
    });

    it("tolerates a drop carrying no file", () => {
      expect(imageFilesFromDrop(null)).toEqual([]);
      expect(imageFilesFromDrop({})).toEqual([]);
    });
  });
});
