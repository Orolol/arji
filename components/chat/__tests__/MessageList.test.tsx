import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageList } from "../MessageList";

beforeAll(() => {
  // jsdom doesn't implement scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();
});

describe("MessageList", () => {
  const baseMessage = {
    id: "msg1",
    role: "user" as const,
    content: "Hello",
    createdAt: new Date().toISOString(),
  };

  it("renders messages with text content", () => {
    render(
      <MessageList
        messages={[baseMessage]}
        loading={false}
      />
    );
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("renders loading state", () => {
    render(<MessageList messages={[]} loading={true} />);
    expect(screen.getByText("Loading messages...")).toBeInTheDocument();
  });

  it("renders empty state when no messages", () => {
    render(<MessageList messages={[]} loading={false} />);
    expect(
      screen.getByText("Start a conversation to brainstorm your project with Claude")
    ).toBeInTheDocument();
  });

  it("renders attached images below message text", () => {
    const messageWithAttachment = {
      ...baseMessage,
      attachments: [
        {
          id: "att1",
          fileName: "screenshot.png",
          mimeType: "image/png",
          url: "/api/projects/proj1/chat/uploads/att1",
        },
      ],
    };

    render(
      <MessageList
        messages={[messageWithAttachment]}
        loading={false}
      />
    );

    const img = screen.getByAltText("screenshot.png");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "/api/projects/proj1/chat/uploads/att1");
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("renders multiple images per message", () => {
    const messageWithMultipleAttachments = {
      ...baseMessage,
      attachments: [
        {
          id: "att1",
          fileName: "first.png",
          mimeType: "image/png",
          url: "/api/projects/proj1/chat/uploads/att1",
        },
        {
          id: "att2",
          fileName: "second.jpg",
          mimeType: "image/jpeg",
          url: "/api/projects/proj1/chat/uploads/att2",
        },
      ],
    };

    render(
      <MessageList
        messages={[messageWithMultipleAttachments]}
        loading={false}
      />
    );

    expect(screen.getByAltText("first.png")).toBeInTheDocument();
    expect(screen.getByAltText("second.jpg")).toBeInTheDocument();
  });

  it("opens lightbox when clicking an image", () => {
    const messageWithAttachment = {
      ...baseMessage,
      attachments: [
        {
          id: "att1",
          fileName: "photo.png",
          mimeType: "image/png",
          url: "/api/projects/proj1/chat/uploads/att1",
        },
      ],
    };

    render(
      <MessageList
        messages={[messageWithAttachment]}
        loading={false}
      />
    );

    // Click the image button to open lightbox
    const imageButton = screen.getByAltText("photo.png").closest("button")!;
    fireEvent.click(imageButton);

    // Lightbox should now show the full-size image
    const lightboxImages = screen.getAllByAltText("photo.png");
    expect(lightboxImages.length).toBeGreaterThan(1); // Original + lightbox
  });

  it("closes lightbox on Escape key", () => {
    const messageWithAttachment = {
      ...baseMessage,
      attachments: [
        {
          id: "att1",
          fileName: "photo.png",
          mimeType: "image/png",
          url: "/api/projects/proj1/chat/uploads/att1",
        },
      ],
    };

    render(
      <MessageList
        messages={[messageWithAttachment]}
        loading={false}
      />
    );

    // Open lightbox
    const imageButton = screen.getByAltText("photo.png").closest("button")!;
    fireEvent.click(imageButton);

    // Verify lightbox is open
    const lightboxImages = screen.getAllByAltText("photo.png");
    expect(lightboxImages.length).toBeGreaterThan(1);

    // Press Escape
    fireEvent.keyDown(document, { key: "Escape" });

    // Lightbox should close - back to just one image
    const imagesAfterClose = screen.getAllByAltText("photo.png");
    expect(imagesAfterClose).toHaveLength(1);
  });

  it("closes lightbox when clicking outside the image", () => {
    const messageWithAttachment = {
      ...baseMessage,
      attachments: [
        {
          id: "att1",
          fileName: "photo.png",
          mimeType: "image/png",
          url: "/api/projects/proj1/chat/uploads/att1",
        },
      ],
    };

    render(
      <MessageList
        messages={[messageWithAttachment]}
        loading={false}
      />
    );

    // Open lightbox
    const imageButton = screen.getByAltText("photo.png").closest("button")!;
    fireEvent.click(imageButton);

    // Click the overlay (not the image)
    const overlay = document.querySelector(".fixed.inset-0")!;
    fireEvent.click(overlay);

    // Lightbox should close
    const imagesAfterClose = screen.getAllByAltText("photo.png");
    expect(imagesAfterClose).toHaveLength(1);
  });

  it("does not render attachment section for messages without attachments", () => {
    render(
      <MessageList
        messages={[baseMessage]}
        loading={false}
      />
    );

    // No images should be present
    const images = document.querySelectorAll("img");
    expect(images).toHaveLength(0);
  });

  it("sets alt text to original filename for accessibility", () => {
    const msg = {
      ...baseMessage,
      attachments: [
        {
          id: "att1",
          fileName: "my-important-screenshot.png",
          mimeType: "image/png",
          url: "/api/projects/proj1/chat/uploads/att1",
        },
      ],
    };

    render(<MessageList messages={[msg]} loading={false} />);

    const img = screen.getByAltText("my-important-screenshot.png");
    expect(img).toBeInTheDocument();
  });
});
