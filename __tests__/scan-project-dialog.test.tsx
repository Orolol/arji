/**
 * ScanProjectDialog — the user-selection step before importing scanned
 * documents: unchecked-by-default checkboxes, "Tout sélectionner", the
 * no-selection no-op, and « déjà importé » marking with no re-import.
 *
 * Real components throughout; only fetch is stubbed.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScanProjectDialog } from "@/components/documents/ScanProjectDialog";

const SCAN_FILES = [
  { name: "README.md", relativePath: "docs/README.md", sizeBytes: 1200 },
  { name: "spec.pdf", relativePath: "docs/spec.pdf", sizeBytes: 2048 },
  // Basename differs only by case from the existing doc — must still be
  // flagged as already imported.
  { name: "Old.md", relativePath: "notes/Old.md", sizeBytes: 300 },
];

interface FetchOverrides {
  existingDocs?: Array<{ originalFilename: string }>;
  importResponse?: { ok: boolean; status?: number; body: unknown };
  /** Per-call sequence for /documents — lets a test change what Arij has
   *  already imported between the first scan and a rescan. */
  existingDocsQueue?: Array<Array<{ originalFilename: string }>>;
}

function mockFetch(overrides: FetchOverrides = {}) {
  let documentsCalls = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/documents/import")) {
      const response = overrides.importResponse ?? {
        ok: true,
        body: {
          data: {
            imported: [],
            skipped: [],
          },
        },
      };
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 400),
        json: async () => response.body,
      };
    }
    if (url.includes("/documents/scan")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            root: "/repo",
            files: SCAN_FILES,
            errors: [],
            truncated: false,
          },
        }),
      };
    }
    if (url.endsWith("/documents")) {
      const docs =
        overrides.existingDocsQueue?.[documentsCalls] ??
        overrides.existingDocs ?? [{ id: "doc-1", originalFilename: "Old.md" }];
      documentsCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: docs }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ data: {} }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDialog(onImported = vi.fn()) {
  render(<ScanProjectDialog projectId="proj-1" onImported={onImported} />);
  // The dialog manages its own open state — the trigger opens it, which
  // kicks off the scan and the existing-documents lookup.
  fireEvent.click(screen.getByRole("button", { name: /Scanner le projet/ }));
  return { onImported };
}

function checkboxFor(relativePath: string): HTMLElement {
  return screen.getByLabelText(`Sélectionner ${relativePath}`);
}
function importCalls(fetchMock: Mock): string[][] {
  return (fetchMock.mock.calls as unknown[][])
    .filter(
      (c) =>
        typeof c[0] === "string" && (c[0] as string).includes("/documents/import")
    )
    .map((c) => JSON.parse((c[1] as { body: string }).body).relativePaths);
}

describe("ScanProjectDialog — selection before import", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with every checkbox unchecked and the import button disabled", async () => {
    const fetchMock = mockFetch();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText("Sélectionner docs/README.md")).not.toBeDisabled()
    );

    for (const file of SCAN_FILES) {
      expect(checkboxFor(file.relativePath)).not.toBeChecked();
    }
    expect(screen.getByLabelText("Tout sélectionner")).not.toBeChecked();

    const button = screen.getByRole("button", { name: /Importer la sélection/ });
    expect(button).toBeDisabled();

    // A click on the disabled button must not reach the import endpoint.
    fireEvent.click(button);
    expect(importCalls(fetchMock)).toHaveLength(0);
  });

  it("marks already-imported files and keeps them non-importable", async () => {
    mockFetch();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByText("déjà importé")).toBeInTheDocument()
    );

    const already = checkboxFor("notes/Old.md");
    expect(already).toBeDisabled();
    // Case-insensitive: the existing doc is "Old.md", the scanned file "Old.md".
    expect(screen.getByText("déjà importé")).toBeInTheDocument();

    // "Tout sélectionner" must not sweep the already-imported file in.
    fireEvent.click(screen.getByLabelText("Tout sélectionner"));
    expect(checkboxFor("docs/README.md")).toBeChecked();
    expect(checkboxFor("docs/spec.pdf")).toBeChecked();
    expect(already).not.toBeChecked();
  });

  it("selects all importable files, imports exactly the selection, then flips rows to déjà importé", async () => {
    const fetchMock = mockFetch({
      importResponse: {
        ok: true,
        body: {
          data: {
            imported: [{ originalFilename: "README.md" }],
            skipped: [
              {
                relativePath: "docs/spec.pdf",
                reason: "Échec de la conversion : boom",
              },
            ],
          },
        },
      },
    });
    const { onImported } = renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText("Sélectionner docs/README.md")).not.toBeDisabled()
    );

    fireEvent.click(screen.getByLabelText("Tout sélectionner"));
    expect(checkboxFor("notes/Old.md")).not.toBeChecked();

    const button = screen.getByRole("button", {
      name: /Importer la sélection \(2\)/,
    });
    fireEvent.click(button);

    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(importCalls(fetchMock)).toEqual([
      ["docs/README.md", "docs/spec.pdf"],
    ]);

    // Selection resets; imported rows become non-importable.
    await waitFor(() =>
      expect(screen.getAllByText("déjà importé")).toHaveLength(2)
    );
    expect(checkboxFor("docs/README.md")).toBeDisabled();
    // The skipped file stays importable for a corrected retry.
    expect(checkboxFor("docs/spec.pdf")).not.toBeDisabled();
    expect(checkboxFor("docs/spec.pdf")).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: /Importer la sélection/ })
    ).toBeDisabled();
    expect(screen.getByText(/1 document importé/)).toBeInTheDocument();
    expect(
      screen.getByText(/docs\/spec\.pdf — Échec de la conversion/)
    ).toBeInTheDocument();
  });
});

describe("ScanProjectDialog — rescan idempotency", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("re-scans in place and marks files imported since the first scan", async () => {
    const fetchMock = mockFetch({
      existingDocsQueue: [
        [{ originalFilename: "Old.md" }],
        // Between the two scans, README.md was imported (upload route,
        // another session…): the second scan must mark it « déjà importé »
        // instead of offering it again.
        [
          { originalFilename: "Old.md" },
          { originalFilename: "README.md" },
        ],
      ],
    });
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText("Sélectionner docs/README.md")).not.toBeDisabled()
    );

    fireEvent.click(screen.getByRole("button", { name: "Relancer le scan" }));

    // Both the scan and the existing-documents lookup run again — the mark
    // must reflect imports that landed elsewhere in between.
    await waitFor(() => {
      const documentLookups = fetchMock.mock.calls.filter(
        (c) => typeof c[0] === "string" && (c[0] as string).endsWith("/documents")
      );
      expect(documentLookups).toHaveLength(2);
    });
    await waitFor(() =>
      expect(screen.getAllByText("déjà importé")).toHaveLength(2)
    );
    expect(checkboxFor("docs/README.md")).toBeDisabled();
    expect(checkboxFor("notes/Old.md")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Importer la sélection/ })
    ).toBeDisabled();

    // Idempotent: a rescan alone never triggers an import, so no duplicate
    // row can appear server-side either.
    expect(importCalls(fetchMock)).toHaveLength(0);
  });

  it("keeps imported documents whose file left the repo visible and signals them", async () => {
    mockFetch({
      existingDocs: [
        { originalFilename: "Old.md" },
        // Not among SCAN_FILES: its source file is gone from the repo.
        { originalFilename: "archived-spec.pdf" },
      ],
    });
    renderDialog();

    await waitFor(() =>
      expect(
        screen.getByText(/ne correspond à aucun fichier du dépôt/)
      ).toBeInTheDocument()
    );
    // The signal names the orphaned document and states it stays accessible…
    expect(screen.getByText("archived-spec.pdf")).toBeInTheDocument();
    expect(screen.getByText(/reste accessible/)).toBeInTheDocument();
    // …while Old.md still matches notes/Old.md in the scan and is NOT
    // signalled — it only appears once, as the scanned row's name.
    expect(screen.getAllByText("Old.md")).toHaveLength(1);
  });
});
