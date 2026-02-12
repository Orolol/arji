import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LogViewer } from "@/components/monitor/LogViewer";

describe("LogViewer", () => {
  it("renders content in a monospace scroll container", () => {
    render(<LogViewer content="hello world" />);

    const contentEl = screen.getByTestId("log-viewer-content");
    expect(contentEl).toBeInTheDocument();
    expect(contentEl).toHaveTextContent("hello world");
    expect(contentEl.className).toContain("font-mono");
    expect(contentEl.className).toContain("overflow-auto");
    expect(contentEl.className).toContain("whitespace-pre-wrap");
  });

  it("applies default maxHeight of 300px", () => {
    render(<LogViewer content="test" />);

    const contentEl = screen.getByTestId("log-viewer-content");
    expect(contentEl.style.maxHeight).toBe("300px");
  });

  it("applies custom maxHeight when provided", () => {
    render(<LogViewer content="test" maxHeight="500px" />);

    const contentEl = screen.getByTestId("log-viewer-content");
    expect(contentEl.style.maxHeight).toBe("500px");
  });

  it("renders label when provided", () => {
    render(<LogViewer content="test" label="Output" />);

    expect(screen.getByText("Output")).toBeInTheDocument();
  });

  it("renders copy button", () => {
    render(<LogViewer content="test" />);

    expect(screen.getByTestId("copy-button")).toBeInTheDocument();
  });

  it("detects and pretty-prints valid JSON objects", () => {
    const json = '{"name":"test","value":42}';
    render(<LogViewer content={json} />);

    const contentEl = screen.getByTestId("log-viewer-content");
    const expected = JSON.stringify(JSON.parse(json), null, 2);
    expect(contentEl.textContent).toBe(expected);
  });

  it("detects and pretty-prints valid JSON arrays", () => {
    const json = '[1,2,3]';
    render(<LogViewer content={json} />);

    const contentEl = screen.getByTestId("log-viewer-content");
    const expected = JSON.stringify(JSON.parse(json), null, 2);
    expect(contentEl.textContent).toBe(expected);
  });

  it("leaves invalid JSON as-is", () => {
    const content = '{not valid json}';
    render(<LogViewer content={content} />);

    const contentEl = screen.getByTestId("log-viewer-content");
    expect(contentEl.textContent).toBe(content);
  });

  it("leaves non-JSON content as-is", () => {
    const content = "just plain text\nwith multiple lines";
    render(<LogViewer content={content} />);

    const contentEl = screen.getByTestId("log-viewer-content");
    expect(contentEl.textContent).toBe(content);
  });

  it("handles JSON with leading/trailing whitespace", () => {
    const json = '  {"key": "value"}  ';
    render(<LogViewer content={json} />);

    const contentEl = screen.getByTestId("log-viewer-content");
    const expected = JSON.stringify({ key: "value" }, null, 2);
    expect(contentEl.textContent).toBe(expected);
  });

  it("copies original content to clipboard on button click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    const originalContent = '{"key":"value"}';
    render(<LogViewer content={originalContent} />);

    fireEvent.click(screen.getByTestId("copy-button"));

    expect(writeText).toHaveBeenCalledWith(originalContent);
  });

  it("applies additional className when provided", () => {
    render(<LogViewer content="test" className="custom-class" />);

    const viewer = screen.getByTestId("log-viewer");
    expect(viewer.className).toContain("custom-class");
  });
});
