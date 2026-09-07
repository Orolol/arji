/**
 * The DOCS card of frame 8b: the `@mention` rows, their derived size suffix
 * (`· 4 KB` / `· converted` / nothing — never `· 0 KB`), and the drop zone
 * surfacing the upload route's own errors, in particular the duplicate-filename
 * 409 that dropping the same file twice produces.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  DocsCard,
  documentSuffix,
  type DocsSuffixCopy,
} from "@/components/spec/DocsCard";

/**
 * `documentSuffix` is a pure derivation, so it takes its copy from the caller
 * (`lib/i18n/catalogue.ts`) exactly as `formatSaveState` does. These are the
 * `Spec.docs.suffix.*` values of the English catalogue.
 */
const SUFFIX_COPY: DocsSuffixCopy = {
  size: (kilobytes) => `· ${kilobytes} KB`,
  converted: "· converted",
};

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-docs" }),
  useRouter: () => ({ push: vi.fn() }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function doc(over: Partial<Parameters<typeof documentSuffix>[0]> = {}) {
  return {
    id: `doc-${Math.random().toString(36).slice(2, 8)}`,
    originalFilename: "sse-notes.md",
    kind: "text" as const,
    mimeType: "text/markdown",
    sizeBytes: 4096,
    ...over,
  };
}

function listResponse(documents: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ data: documents }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue(listResponse([]));
});

describe("documentSuffix", () => {
  it("prints kilobytes for a sized document", () => {
    expect(documentSuffix(doc({ sizeBytes: 4096 }), SUFFIX_COPY)).toBe(" · 4 KB");
    expect(documentSuffix(doc({ sizeBytes: 11 * 1024 }), SUFFIX_COPY)).toBe(
      " · 11 KB",
    );
  });

  it("never prints 0 KB for a tiny document", () => {
    expect(documentSuffix(doc({ sizeBytes: 200 }), SUFFIX_COPY)).toBe(" · 1 KB");
  });

  it("prints `converted` for a converted text document with no stored size", () => {
    expect(
      documentSuffix(
        doc({ sizeBytes: null, kind: "text", mimeType: "application/pdf" }),
        SUFFIX_COPY,
      ),
    ).toBe(" · converted");
  });

  it("prints nothing when neither a size nor a conversion is known", () => {
    expect(
      documentSuffix(
        doc({ sizeBytes: null, kind: "text", mimeType: "text/markdown" }),
        SUFFIX_COPY,
      ),
    ).toBeNull();
    expect(
      documentSuffix(
        doc({ sizeBytes: 0, kind: "image", mimeType: "image/png" }),
        SUFFIX_COPY,
      ),
    ).toBeNull();
  });
});

describe("DocsCard", () => {
  it("names each row with formatDocumentMention, bracing filenames with spaces", async () => {
    render(
      <DocsCard
        projectId="proj-docs"
        initialDocuments={[
          doc({ id: "d1", originalFilename: "sse-notes.md", sizeBytes: 4096 }),
          doc({
            id: "d2",
            originalFilename: "api contract.md",
            sizeBytes: 11 * 1024,
          }),
        ]}
      />,
    );

    const rows = screen.getAllByTestId("docs-card-row");
    expect(rows[0]).toHaveTextContent("@sse-notes.md · 4 KB");
    expect(rows[1]).toHaveTextContent("@{api contract.md} · 11 KB");
  });

  it("renders `· converted` for a converted row and no suffix at all for an unknown one", () => {
    render(
      <DocsCard
        projectId="proj-docs"
        initialDocuments={[
          doc({
            id: "d1",
            originalFilename: "onboarding.pdf",
            sizeBytes: null,
            mimeType: "application/pdf",
          }),
          doc({
            id: "d2",
            originalFilename: "scanned.md",
            sizeBytes: null,
            mimeType: "text/markdown",
          }),
        ]}
      />,
    );

    const rows = screen.getAllByTestId("docs-card-row");
    expect(rows[0]).toHaveTextContent("@onboarding.pdf · converted");
    expect(rows[1]).toHaveTextContent("@scanned.md");
    expect(rows[1].textContent).not.toContain("·");
    expect(rows[1].textContent).not.toContain("0 KB");
  });

  it("caps the list at six rows and links to the documents page for the rest", () => {
    render(
      <DocsCard
        projectId="proj-docs"
        initialDocuments={Array.from({ length: 9 }, (_, i) =>
          doc({ id: `d${i}`, originalFilename: `doc-${i}.md` }),
        )}
      />,
    );

    expect(screen.getAllByTestId("docs-card-row")).toHaveLength(6);
    expect(screen.getByRole("link", { name: /3 more/ })).toHaveAttribute(
      "href",
      "/projects/proj-docs/documents",
    );
  });

  it("renders the drop zone copy verbatim", () => {
    render(<DocsCard projectId="proj-docs" initialDocuments={[]} />);
    expect(screen.getByTestId("docs-drop-zone")).toHaveTextContent(
      "Drop a doc — cited with @ in the chat",
    );
  });

  it("surfaces the upload route's 409 message under the drop zone", async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: 'A document named "sse-notes.md" already exists in this project.',
          }),
        };
      }
      return listResponse([]);
    });

    render(<DocsCard projectId="proj-docs" initialDocuments={[]} />);

    const input = screen.getByTestId("docs-file-input") as HTMLInputElement;
    const file = new File(["# notes"], "sse-notes.md", { type: "text/markdown" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId("docs-upload-error")).toHaveTextContent(
        'A document named "sse-notes.md" already exists in this project.',
      );
    });
  });
});
