import { describe, expect, it } from "vitest";
import {
  isServableUploadFileName,
  parseTicketImages,
  ticketImageUrl,
  uploadFileNameFromPath,
  uploadsDirectoryFor,
} from "@/lib/uploads/ticket-images";

/**
 * `epics.images` is free-form text written straight from a request body, and
 * it predates the bug-attachment feature — so the panel reads it through a
 * normaliser that has to answer for every shape the column can hold, not just
 * the one the create modal writes.
 */
describe("parseTicketImages", () => {
  const projectId = "proj-1";
  const storedPath = `data/uploads/${projectId}/abc123-screenshot.png`;

  it("turns the create modal's stored JSON into servable thumbnails", () => {
    expect(parseTicketImages(JSON.stringify([storedPath]), projectId)).toEqual([
      {
        path: storedPath,
        fileName: "abc123-screenshot.png",
        url: `/api/projects/${projectId}/uploads/abc123-screenshot.png`,
      },
    ]);
  });

  it("keeps every image, in order, including repeats", () => {
    const second = `data/uploads/${projectId}/def456-second.png`;

    const images = parseTicketImages(
      JSON.stringify([storedPath, second, storedPath]),
      projectId
    );

    expect(images.map((image) => image.fileName)).toEqual([
      "abc123-screenshot.png",
      "def456-second.png",
      "abc123-screenshot.png",
    ]);
  });

  // Every ticket that existed before this feature holds one of these.
  it.each([
    ["null column", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace", "   "],
    ["empty array", "[]"],
    ["malformed JSON", "[not json"],
    ["a JSON object", '{"path":"x"}'],
    ["a bare JSON string", '"data/uploads/proj-1/a.png"'],
    ["a number", 42],
  ])("renders nothing for %s", (_label, raw) => {
    expect(parseTicketImages(raw, projectId)).toEqual([]);
  });

  it("drops non-string members without losing their valid siblings", () => {
    const images = parseTicketImages(
      JSON.stringify([null, storedPath, 7, { path: storedPath }, ""]),
      projectId
    );

    expect(images.map((image) => image.path)).toEqual([storedPath]);
  });

  it("accepts an already-parsed array, so a route may hand one over", () => {
    expect(parseTicketImages([storedPath], projectId)).toHaveLength(1);
  });

  it("refuses paths belonging to another project", () => {
    expect(
      parseTicketImages(JSON.stringify(["data/uploads/proj-2/other.png"]), projectId)
    ).toEqual([]);
  });

  it.each([
    ["directory traversal", "data/uploads/proj-1/../../../etc/passwd"],
    ["a nested path", "data/uploads/proj-1/nested/shot.png"],
    ["an absolute path", "/etc/passwd"],
    ["a path outside uploads", "data/arij.db"],
    ["a prefix look-alike", "data/uploads/proj-10/shot.png"],
    ["the directory itself", "data/uploads/proj-1/"],
    ["a windows separator", "data/uploads/proj-1/..\\secrets.png"],
  ])("refuses %s", (_label, path) => {
    expect(parseTicketImages(JSON.stringify([path]), projectId)).toEqual([]);
  });
});

describe("upload path helpers", () => {
  it("agrees with the path the upload route writes", () => {
    // `POST /chat/upload` builds `data/uploads/${projectId}/${diskName}`.
    expect(uploadsDirectoryFor("proj-1")).toBe("data/uploads/proj-1");
  });

  it("round-trips a stored path back to its file name", () => {
    expect(uploadFileNameFromPath("data/uploads/proj-1/shot.png", "proj-1")).toBe(
      "shot.png"
    );
    expect(uploadFileNameFromPath("./data/uploads/proj-1/shot.png", "proj-1")).toBe(
      "shot.png"
    );
    expect(uploadFileNameFromPath("  data/uploads/proj-1/shot.png  ", "proj-1")).toBe(
      "shot.png"
    );
  });

  it("percent-encodes a name that would otherwise change the URL's shape", () => {
    expect(ticketImageUrl("proj-1", "a b?c.png")).toBe(
      "/api/projects/proj-1/uploads/a%20b%3Fc.png"
    );
  });

  it.each([".", "..", "", "a/b", "a\\b", "a\0b"])(
    "rejects %j as a servable file name",
    (fileName) => {
      expect(isServableUploadFileName(fileName)).toBe(false);
    }
  );

  it("accepts the sanitised names the upload route produces", () => {
    expect(isServableUploadFileName("V1StGXR8_Z5-pasted-image-1755.png")).toBe(true);
  });
});
