import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BugCreateDialog } from "@/components/kanban/BugCreateDialog";

/**
 * Image attachments in the bug creation modal: clipboard paste, the attach
 * button, drag and drop, refusal of what the chat upload route would refuse,
 * per-thumbnail removal, and what ends up in the create payload.
 */
describe("BugCreateDialog attachments", () => {
  let uploadCount = 0;

  function imageFile(name: string, type = "image/png", size = 2048): File {
    const file = new File(["fake-image"], name, { type });
    Object.defineProperty(file, "size", { value: size });
    return file;
  }

  /** Answers uploads with a distinct attachment each time. */
  function mockFetch() {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith("/chat/upload")) {
        uploadCount += 1;
        const id = `att-${uploadCount}`;
        return {
          ok: true,
          json: async () => ({
            data: {
              id,
              fileName: `shot-${uploadCount}.png`,
              filePath: `data/uploads/proj-1/${id}-shot-${uploadCount}.png`,
              mimeType: "image/png",
              sizeBytes: 2048,
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ data: { id: "bug-1" } }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function renderDialog() {
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();
    render(
      <BugCreateDialog
        projectId="proj-1"
        open={true}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />
    );
    return { onOpenChange, onCreated };
  }

  function descriptionField() {
    return screen.getByPlaceholderText(
      "Steps to reproduce, expected vs actual behavior..."
    );
  }

  function fileInput() {
    return document.querySelector('input[type="file"]') as HTMLInputElement;
  }

  function pasteFiles(files: File[]) {
    fireEvent.paste(descriptionField(), {
      clipboardData: {
        items: files.map((file) => ({ type: file.type, getAsFile: () => file })),
      },
    });
  }

  function uploadCalls(fetchMock: ReturnType<typeof mockFetch>) {
    return fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/chat/upload")
    );
  }

  /** Uploads the modal asked the server to throw away, in call order. */
  function discardedUploadIds(fetchMock: ReturnType<typeof mockFetch>) {
    return fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")
      .map(([url]) => String(url).split("/").pop());
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    uploadCount = 0;
  });

  it("attaches the clipboard image on Ctrl/Cmd+V", async () => {
    const fetchMock = mockFetch();
    renderDialog();

    pasteFiles([imageFile("screenshot.png")]);

    await waitFor(() => {
      expect(uploadCalls(fetchMock)).toHaveLength(1);
    });
    expect(uploadCalls(fetchMock)[0]![0]).toBe("/api/projects/proj-1/chat/upload");
    expect(
      (uploadCalls(fetchMock)[0]![1] as RequestInit).method
    ).toBe("POST");
    expect(
      (uploadCalls(fetchMock)[0]![1] as RequestInit).body
    ).toBeInstanceOf(FormData);

    await waitFor(() => {
      expect(screen.getByAltText("shot-1.png")).toBeInTheDocument();
    });
  });

  it("leaves a text-only paste alone", () => {
    const fetchMock = mockFetch();
    renderDialog();

    fireEvent.paste(descriptionField(), {
      clipboardData: { items: [{ type: "text/plain", getAsFile: () => null }] },
    });

    expect(uploadCalls(fetchMock)).toHaveLength(0);
  });

  it("attaches an image picked through the Attach image button", async () => {
    const fetchMock = mockFetch();
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Attach image" }));
    expect(clickSpy).toHaveBeenCalledTimes(1);

    fireEvent.change(fileInput(), { target: { files: [imageFile("from-disk.png")] } });

    await waitFor(() => expect(uploadCalls(fetchMock)).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByAltText("shot-1.png")).toBeInTheDocument()
    );
  });

  it("attaches a dropped image", async () => {
    const fetchMock = mockFetch();
    renderDialog();

    fireEvent.drop(screen.getByTestId("bug-create-drop-zone"), {
      dataTransfer: { files: [imageFile("dropped.png")] },
    });

    await waitFor(() => expect(uploadCalls(fetchMock)).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByAltText("shot-1.png")).toBeInTheDocument()
    );
  });

  it("attaches an image dropped on the modal chrome, away from the fields", async () => {
    const fetchMock = mockFetch();
    renderDialog();

    // The footer sits outside the field stack. A near-miss drop there must be
    // swallowed by the modal: left to the browser, the default action
    // navigates to the dropped file and the typed report is gone.
    const reachedTheBrowser = fireEvent.drop(
      screen.getByRole("button", { name: "Cancel" }),
      { dataTransfer: { files: [imageFile("near-miss.png")] } }
    );

    expect(reachedTheBrowser).toBe(false);
    await waitFor(() => expect(uploadCalls(fetchMock)).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByAltText("shot-1.png")).toBeInTheDocument()
    );
  });

  it("attaches the clipboard image when focus is on the modal, not a field", async () => {
    const fetchMock = mockFetch();
    renderDialog();

    // Clicking the modal's chrome parks focus on the dialog container itself,
    // so this is where Ctrl/Cmd+V lands — no field involved.
    fireEvent.paste(screen.getByRole("dialog"), {
      clipboardData: {
        items: [{ type: "image/png", getAsFile: () => imageFile("screenshot.png") }],
      },
    });

    await waitFor(() => expect(uploadCalls(fetchMock)).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByAltText("shot-1.png")).toBeInTheDocument()
    );
  });

  it("refuses a non-image file with a message naming the allowed types", async () => {
    const fetchMock = mockFetch();
    renderDialog();

    fireEvent.drop(screen.getByTestId("bug-create-drop-zone"), {
      dataTransfer: { files: [imageFile("trace.pdf", "application/pdf")] },
    });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "trace.pdf: Unsupported file type: application/pdf. Allowed: png, jpg, jpeg, gif, webp"
      )
    );
    expect(uploadCalls(fetchMock)).toHaveLength(0);
  });

  it("refuses a file over the chat upload size limit", async () => {
    const fetchMock = mockFetch();
    renderDialog();

    fireEvent.drop(screen.getByTestId("bug-create-drop-zone"), {
      dataTransfer: {
        files: [imageFile("huge.png", "image/png", 11 * 1024 * 1024)],
      },
    });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "huge.png: File too large (11.0MB). Max: 10MB"
      )
    );
    expect(uploadCalls(fetchMock)).toHaveLength(0);
  });

  it("keeps the valid image of a mixed batch and reports the refused one", async () => {
    const fetchMock = mockFetch();
    renderDialog();

    fireEvent.drop(screen.getByTestId("bug-create-drop-zone"), {
      dataTransfer: {
        files: [imageFile("good.png"), imageFile("notes.txt", "text/plain")],
      },
    });

    await waitFor(() => expect(uploadCalls(fetchMock)).toHaveLength(1));
    expect(screen.getByRole("alert")).toHaveTextContent("notes.txt");
    await waitFor(() =>
      expect(screen.getByAltText("shot-1.png")).toBeInTheDocument()
    );
  });

  it("surfaces an upload the server refuses", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith("/chat/upload")) {
        return { ok: false, json: async () => ({ error: "Disk is full" }) };
      }
      return { ok: true, json: async () => ({ data: { id: "bug-1" } }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderDialog();

    pasteFiles([imageFile("screenshot.png")]);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Disk is full")
    );
    expect(screen.queryByTestId("image-attachment-strip")).toBeNull();
  });

  it("removes attachments one at a time, keeping the others", async () => {
    mockFetch();
    renderDialog();

    pasteFiles([imageFile("first.png")]);
    await waitFor(() => expect(screen.getByAltText("shot-1.png")).toBeInTheDocument());
    pasteFiles([imageFile("second.png")]);
    await waitFor(() => expect(screen.getByAltText("shot-2.png")).toBeInTheDocument());
    pasteFiles([imageFile("third.png")]);
    await waitFor(() => expect(screen.getByAltText("shot-3.png")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Remove shot-2.png" }));

    expect(screen.queryByAltText("shot-2.png")).toBeNull();
    expect(screen.getByAltText("shot-1.png")).toBeInTheDocument();
    expect(screen.getByAltText("shot-3.png")).toBeInTheDocument();
  });

  it("sends the attached image paths when the bug is created", async () => {
    const fetchMock = mockFetch();
    renderDialog();

    pasteFiles([imageFile("first.png")]);
    await waitFor(() => expect(screen.getByAltText("shot-1.png")).toBeInTheDocument());
    pasteFiles([imageFile("second.png")]);
    await waitFor(() => expect(screen.getByAltText("shot-2.png")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Remove shot-1.png" }));

    fireEvent.change(screen.getByPlaceholderText("Bug title..."), {
      target: { value: "Avatar renders upside down" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Bug" }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/bugs")
      );
      expect(createCall).toBeTruthy();
      const body = JSON.parse(String((createCall![1] as RequestInit).body));
      expect(body.images).toEqual(["data/uploads/proj-1/att-2-shot-2.png"]);
    });
  });

  it("omits images entirely when no screenshot is attached", async () => {
    const fetchMock = mockFetch();
    renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Bug title..."), {
      target: { value: "Plain text bug" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Bug" }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/bugs")
      );
      expect(createCall).toBeTruthy();
      const body = JSON.parse(String((createCall![1] as RequestInit).body));
      expect("images" in body).toBe(false);
    });
  });

  it("blocks creation while an upload is still in flight", async () => {
    let releaseUpload: (() => void) | null = null;
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith("/chat/upload")) {
        await new Promise<void>((resolve) => {
          releaseUpload = resolve;
        });
        return {
          ok: true,
          json: async () => ({
            data: {
              id: "att-1",
              fileName: "shot-1.png",
              filePath: "data/uploads/proj-1/att-1-shot-1.png",
              mimeType: "image/png",
              sizeBytes: 2048,
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ data: { id: "bug-1" } }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Bug title..."), {
      target: { value: "Screenshot bug" },
    });
    pasteFiles([imageFile("screenshot.png")]);

    const createButton = screen.getByRole("button", { name: "Create Bug" });
    await waitFor(() => expect(createButton).toBeDisabled());

    fireEvent.click(createButton);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/bugs"))
    ).toHaveLength(0);

    releaseUpload!();
    await waitFor(() => expect(createButton).not.toBeDisabled());

    fireEvent.click(createButton);
    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/bugs")
      );
      const body = JSON.parse(String((createCall![1] as RequestInit).body));
      expect(body.images).toEqual(["data/uploads/proj-1/att-1-shot-1.png"]);
    });
  });

  it("keeps creation blocked until the slower of two overlapping uploads lands", async () => {
    // Paste and drop stay live during a transfer, so two batches overlap as
    // soon as the user pastes a second screenshot without waiting.
    const heldUploads: Array<() => void> = [];
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith("/chat/upload")) {
        uploadCount += 1;
        const index = uploadCount;
        if (index === 1) {
          await new Promise<void>((resolve) => heldUploads.push(resolve));
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              id: `att-${index}`,
              fileName: `shot-${index}.png`,
              filePath: `data/uploads/proj-1/att-${index}.png`,
              mimeType: "image/png",
              sizeBytes: 2048,
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ data: { id: "bug-1" } }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Bug title..."), {
      target: { value: "Two screenshots" },
    });
    pasteFiles([imageFile("slow.png")]);
    pasteFiles([imageFile("fast.png")]);

    // The second paste has landed while the first is still on the wire.
    await waitFor(() =>
      expect(screen.getByAltText("shot-2.png")).toBeInTheDocument()
    );

    const createButton = screen.getByRole("button", { name: "Create Bug" });
    expect(createButton).toBeDisabled();
    fireEvent.click(createButton);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/bugs"))
    ).toHaveLength(0);

    heldUploads.forEach((release) => release());
    await waitFor(() => expect(createButton).not.toBeDisabled());

    fireEvent.click(createButton);
    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/bugs")
      );
      expect(createCall).toBeTruthy();
      const body = JSON.parse(String((createCall![1] as RequestInit).body));
      expect(body.images).toEqual([
        "data/uploads/proj-1/att-2.png",
        "data/uploads/proj-1/att-1.png",
      ]);
    });
  });

  it("drops an upload that lands after the form was cleared", async () => {
    let releaseUpload: (() => void) | null = null;
    let releaseFirstCreate: (() => void) | null = null;
    let creates = 0;
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith("/chat/upload")) {
        await new Promise<void>((resolve) => {
          releaseUpload = resolve;
        });
        return {
          ok: true,
          json: async () => ({
            data: {
              id: "att-late",
              fileName: "late.png",
              filePath: "data/uploads/proj-1/att-late.png",
              mimeType: "image/png",
              sizeBytes: 2048,
            },
          }),
        };
      }
      creates += 1;
      if (creates === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstCreate = resolve;
        });
      }
      return { ok: true, json: async () => ({ data: { id: `bug-${creates}` } }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { onOpenChange } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Bug title..."), {
      target: { value: "First bug" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Bug" }));
    await waitFor(() => expect(releaseFirstCreate).toBeTruthy());

    // Pasted after the user committed: the create request is already in flight.
    pasteFiles([imageFile("late.png")]);
    await waitFor(() => expect(releaseUpload).toBeTruthy());

    releaseFirstCreate!();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    // The upload now answers into a form that has been reset. Staging it would
    // put a screenshot the user never sees on the *next* bug they file.
    releaseUpload!();

    const createButton = screen.getByRole("button", { name: "Create Bug" });
    fireEvent.change(screen.getByPlaceholderText("Bug title..."), {
      target: { value: "Second bug" },
    });
    await waitFor(() => expect(createButton).not.toBeDisabled());
    fireEvent.click(createButton);

    await waitFor(() => {
      const createCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/bugs")
      );
      expect(createCalls).toHaveLength(2);
      const body = JSON.parse(String((createCalls[1]![1] as RequestInit).body));
      expect(body.title).toBe("Second bug");
      expect("images" in body).toBe(false);
    });
    expect(screen.queryByTestId("image-attachment-strip")).toBeNull();
  });

  it("clears staged attachments once the bug is created", async () => {
    mockFetch();
    renderDialog();

    pasteFiles([imageFile("screenshot.png")]);
    await waitFor(() => expect(screen.getByAltText("shot-1.png")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("Bug title..."), {
      target: { value: "Bug with a screenshot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Bug" }));

    await waitFor(() => expect(screen.queryByAltText("shot-1.png")).toBeNull());
  });

  /**
   * A screenshot is uploaded the moment it is pasted, so anything that leaves
   * the staging area without being submitted leaves a real file behind unless
   * the modal says so.
   */
  describe("uploads nobody ends up owning", () => {
    it("throws away the screenshot behind a removed thumbnail", async () => {
      const fetchMock = mockFetch();
      renderDialog();

      pasteFiles([imageFile("first.png")]);
      await waitFor(() => expect(screen.getByAltText("shot-1.png")).toBeInTheDocument());
      pasteFiles([imageFile("second.png")]);
      await waitFor(() => expect(screen.getByAltText("shot-2.png")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "Remove shot-1.png" }));

      await waitFor(() => expect(discardedUploadIds(fetchMock)).toEqual(["att-1"]));
    });

    it("throws away everything still staged when the form is cancelled", async () => {
      const fetchMock = mockFetch();
      const { onOpenChange } = renderDialog();

      pasteFiles([imageFile("first.png")]);
      await waitFor(() => expect(screen.getByAltText("shot-1.png")).toBeInTheDocument());
      pasteFiles([imageFile("second.png")]);
      await waitFor(() => expect(screen.getByAltText("shot-2.png")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() =>
        expect(discardedUploadIds(fetchMock)).toEqual(["att-1", "att-2"])
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(screen.queryByTestId("image-attachment-strip")).toBeNull();
    });

    it("keeps the screenshots of a bug that was actually filed", async () => {
      const fetchMock = mockFetch();
      renderDialog();

      pasteFiles([imageFile("screenshot.png")]);
      await waitFor(() => expect(screen.getByAltText("shot-1.png")).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText("Bug title..."), {
        target: { value: "Bug with a screenshot" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create Bug" }));

      // The reset that empties the strip after a successful submit must not be
      // the same reset that deletes files — the bug owns them now.
      await waitFor(() => expect(screen.queryByAltText("shot-1.png")).toBeNull());
      expect(discardedUploadIds(fetchMock)).toEqual([]);
    });

    it("throws away an upload that lands after the form was cleared", async () => {
      let releaseUpload: (() => void) | null = null;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/chat/upload")) {
          await new Promise<void>((resolve) => {
            releaseUpload = resolve;
          });
          return {
            ok: true,
            json: async () => ({
              data: {
                id: "att-late",
                fileName: "late.png",
                filePath: "data/uploads/proj-1/att-late.png",
                mimeType: "image/png",
                sizeBytes: 2048,
              },
            }),
          };
        }
        void init;
        return { ok: true, json: async () => ({ data: { id: "bug-1" } }) };
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      renderDialog();

      pasteFiles([imageFile("late.png")]);
      await waitFor(() => expect(releaseUpload).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      releaseUpload!();

      // Nothing that survives the cancel knows this upload exists, so the
      // transfer that answers into the closed form has to clean up after it.
      await waitFor(() =>
        expect(
          discardedUploadIds(fetchMock as unknown as ReturnType<typeof mockFetch>)
        ).toContain("att-late")
      );
    });
  });
});
