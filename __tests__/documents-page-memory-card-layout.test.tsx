/**
 * Docs page layout — where the below-`lg` memory card lives in the tree.
 *
 * The aside that normally carries the memory card (and the only manual Dream
 * button) is `hidden lg:flex`, so a narrow screen gets a duplicate. That
 * duplicate was rendered as a SIBLING of the documents column inside a
 * row-direction flex container: instead of stacking under the documents, it
 * became a second column beside them and squeezed both.
 *
 * jsdom applies no CSS, so this pins the structure rather than the pixels —
 * which is exactly where the bug was.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

vi.mock("@/components/documents/UploadZone", () => ({
  UploadZone: () => <div data-testid="upload-zone" />,
}));
vi.mock("@/components/documents/ScanProjectDialog", () => ({
  ScanProjectDialog: () => <div data-testid="scan-dialog" />,
}));
vi.mock("@/components/documents/DocumentViewer", () => ({
  DocumentViewer: () => <div data-testid="document-viewer" />,
}));
vi.mock("@/components/documents/ProjectMemoryCard", () => ({
  ProjectMemoryCard: () => <div data-testid="memory-card" />,
}));

const DocumentsPage = (await import("@/app/projects/[projectId]/documents/page"))
  .default;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [] }),
    }))
  );
});

describe("documents page — memory card placement", () => {
  it("stacks the below-lg memory card inside the documents column", async () => {
    const { container } = render(<DocumentsPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId("memory-card")).toHaveLength(2);
    });

    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();

    // The row that lays the page out below the header.
    const row = aside!.parentElement!;
    expect(row.className).toContain("flex-1");

    // Exactly two columns on that row: the documents column and the aside.
    // A third child is the regression — it lands beside the documents instead
    // of under them.
    expect(row.children).toHaveLength(2);

    const mainColumn = Array.from(row.children).find((el) => el !== aside)!;
    const mobileCard = container.querySelector(
      '.lg\\:hidden [data-testid="memory-card"]'
    );
    expect(mobileCard).not.toBeNull();
    expect(mainColumn.contains(mobileCard)).toBe(true);

    // The other copy is the one the aside shows from `lg` up.
    expect(aside!.querySelector('[data-testid="memory-card"]')).not.toBeNull();
  });
});
