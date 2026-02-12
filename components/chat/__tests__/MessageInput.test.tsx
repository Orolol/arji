import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageInput } from "../MessageInput";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("MessageInput", () => {
  const defaultProps = {
    projectId: "proj1",
    onSend: vi.fn(),
    disabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            id: "att-123",
            fileName: "test.png",
            mimeType: "image/png",
            sizeBytes: 1000,
          },
        }),
    });
  });

  it("renders textarea and buttons", () => {
    render(<MessageInput {...defaultProps} />);
    expect(screen.getByPlaceholderText("Type a message...")).toBeInTheDocument();
    expect(screen.getByTitle("Attach image")).toBeInTheDocument();
  });

  it("sends message with text and no attachments", async () => {
    const onSend = vi.fn();
    render(<MessageInput {...defaultProps} onSend={onSend} />);

    const textarea = screen.getByPlaceholderText("Type a message...");
    await userEvent.type(textarea, "Hello world");

    // Find the send button (the one without a title)
    const sendButton = screen.getAllByRole("button").find(
      (btn) => !btn.getAttribute("title") && !btn.getAttribute("type")?.includes("button")
    ) || screen.getAllByRole("button")[1]; // Fallback: second button is send

    fireEvent.click(sendButton);

    expect(onSend).toHaveBeenCalledWith("Hello world", []);
  });

  it("disables textarea and buttons when disabled prop is true", () => {
    render(<MessageInput {...defaultProps} disabled={true} />);
    expect(screen.getByPlaceholderText("Type a message...")).toBeDisabled();
    expect(screen.getByTitle("Attach image")).toBeDisabled();
  });

  it("has a hidden file input that accepts image types", () => {
    render(<MessageInput {...defaultProps} />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    expect(fileInput.accept).toBe("image/png,image/jpg,image/jpeg,image/gif,image/webp");
    expect(fileInput.multiple).toBe(true);
    expect(fileInput.className).toContain("hidden");
  });

  it("uploads file and shows thumbnail when file is selected", async () => {
    render(<MessageInput {...defaultProps} />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["fake-image"], "test.png", { type: "image/png" });

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/projects/proj1/chat/upload",
        expect.objectContaining({ method: "POST" })
      );
    });

    // After upload, thumbnail should appear
    await waitFor(() => {
      const img = document.querySelector('img[alt="test.png"]') as HTMLImageElement;
      expect(img).toBeTruthy();
    });
  });

  it("uploads pasted image from clipboard", async () => {
    render(<MessageInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText("Type a message...");

    const file = new File(["image-data"], "image.png", { type: "image/png" });
    const clipboardData = {
      items: [
        {
          type: "image/png",
          getAsFile: () => file,
        },
      ],
    };

    fireEvent.paste(textarea, { clipboardData });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/projects/proj1/chat/upload",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("does not intercept text-only paste", () => {
    render(<MessageInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText("Type a message...");

    const clipboardData = {
      items: [
        {
          type: "text/plain",
          getAsFile: () => null,
        },
      ],
    };

    fireEvent.paste(textarea, { clipboardData });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends attachment IDs when submitting with attachments", async () => {
    const onSend = vi.fn();
    render(<MessageInput {...defaultProps} onSend={onSend} />);

    // Upload a file first
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["fake-image"], "test.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      const img = document.querySelector('img[alt="test.png"]');
      expect(img).toBeTruthy();
    });

    // Type some text and send
    const textarea = screen.getByPlaceholderText("Type a message...");
    await userEvent.type(textarea, "Check this image");

    // Submit with Enter
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(onSend).toHaveBeenCalledWith("Check this image", ["att-123"]);
  });

  it("clears attachments after sending", async () => {
    const onSend = vi.fn();
    render(<MessageInput {...defaultProps} onSend={onSend} />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["fake-image"], "test.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(document.querySelector('img[alt="test.png"]')).toBeTruthy();
    });

    const textarea = screen.getByPlaceholderText("Type a message...");
    await userEvent.type(textarea, "msg");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // Thumbnail should be gone
    await waitFor(() => {
      expect(document.querySelector('img[alt="test.png"]')).toBeNull();
    });
  });
});
