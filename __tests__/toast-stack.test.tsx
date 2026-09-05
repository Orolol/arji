import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastStack, TOAST_DURATION_MS, MAX_TOASTS, type ToastItem } from "@/components/notifications/ToastStack";

const success: ToastItem = { id: "one", type: "success", message: "Ticket créé", href: "/projects/p1?ticket=e1", actionLabel: "Voir le ticket" };
afterEach(() => vi.useRealTimers());

describe("shared toast stack", () => {
  it("escapes the page scroll container and announces success", () => {
    const { container } = render(<ToastStack items={[success]} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.getByRole("status")).toHaveTextContent("Ticket créé");
    expect(screen.getByRole("region", { name: "Notifications" }).parentElement).toBe(document.body);
  });

  it("expires success, pauses for hover and keyboard focus, and cleans up on unmount", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    const { unmount } = render(<ToastStack items={[success]} onDismiss={dismiss} />);
    fireEvent.mouseEnter(screen.getByRole("status"));
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS * 2));
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.focus(screen.getByRole("link"));
    fireEvent.mouseLeave(screen.getByRole("status"));
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS * 2));
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByRole("link"));
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS));
    expect(dismiss).toHaveBeenCalledExactlyOnceWith("one");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps errors and warnings until explicitly dismissed", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    render(<ToastStack items={[{ ...success, type: "error" }, { ...success, id: "two", type: "warning" }]} onDismiss={dismiss} />);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS * 3));
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Fermer la notification" })[0]);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith("one");
  });

  it("bounds the visible stack to the newest notifications", () => {
    render(<ToastStack items={Array.from({ length: 10 }, (_, id) => ({ ...success, id: String(id), message: `Message ${id}` }))} onDismiss={vi.fn()} />);
    expect(screen.getAllByRole("status")).toHaveLength(MAX_TOASTS);
    expect(screen.queryByText("Message 0")).not.toBeInTheDocument();
    expect(screen.getByText("Message 9")).toBeInTheDocument();
  });
});
