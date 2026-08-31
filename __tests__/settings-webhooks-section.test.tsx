import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SettingsPage from "@/app/settings/integrations/page";

let webhookRows: Array<{ projectId: string; projectName: string; url: string }> =
  [];
let putCalls: Array<Record<string, unknown>> = [];
let putShouldFail = false;

beforeEach(() => {
  webhookRows = [];
  putCalls = [];
  putShouldFail = false;

  global.fetch = vi
    .fn()
    .mockImplementation((url: string, opts?: RequestInit) => {
      if (url === "/api/settings/webhooks" && opts?.method === "PUT") {
        const body = JSON.parse(opts.body as string) as Record<string, unknown>;
        putCalls.push(body);
        return Promise.resolve({
          ok: !putShouldFail,
          json: () =>
            Promise.resolve(
              putShouldFail
                ? { error: "Webhook URL must be an absolute http:// or https:// URL" }
                : { data: { projectId: body.projectId, url: body.url } }
            ),
        });
      }

      if (url === "/api/settings/webhooks") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { webhooks: webhookRows } }),
        });
      }

      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) });
    });
});

describe("Settings page — Webhooks section", () => {
  function webhooksSection() {
    return within(screen.getByTestId("webhooks-settings"));
  }
  it("renders the empty state when there are no projects", async () => {
    render(<SettingsPage />);

    expect(
      screen.getByRole("heading", { name: "Webhooks" })
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByText("No projects yet. Create a project to configure a webhook.")
      ).toBeInTheDocument()
    );
  });

  it("lists one input per project prefilled with the stored URL", async () => {
    webhookRows = [
      { projectId: "p1", projectName: "Arij", url: "https://ntfy.sh/arij" },
      { projectId: "p2", projectName: "Zeta", url: "" },
    ];

    render(<SettingsPage />);

    const arijInput = (await screen.findByLabelText("Arij")) as HTMLInputElement;
    const zetaInput = screen.getByLabelText("Zeta") as HTMLInputElement;
    expect(arijInput.value).toBe("https://ntfy.sh/arij");
    expect(zetaInput.value).toBe("");
  });

  it("PUTs the edited URL for the right project and confirms", async () => {
    webhookRows = [
      { projectId: "p1", projectName: "Arij", url: "" },
      { projectId: "p2", projectName: "Zeta", url: "" },
    ];

    render(<SettingsPage />);

    const zetaInput = await screen.findByLabelText("Zeta");
    fireEvent.change(zetaInput, {
      target: { value: "  https://discord.com/api/webhooks/x  " },
    });
    fireEvent.click(webhooksSection().getAllByRole("button", { name: "Save" })[1]);

    await waitFor(() => expect(putCalls).toHaveLength(1));
    expect(putCalls[0]).toEqual({
      projectId: "p2",
      url: "https://discord.com/api/webhooks/x",
    });
    expect(
      await screen.findByText("Webhook saved for Zeta.")
    ).toBeInTheDocument();
  });

  it("reports a clear when the field is emptied", async () => {
    webhookRows = [
      { projectId: "p1", projectName: "Arij", url: "https://ntfy.sh/arij" },
    ];

    render(<SettingsPage />);

    fireEvent.change(await screen.findByLabelText("Arij"), {
      target: { value: "" },
    });
    fireEvent.click(webhooksSection().getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putCalls).toHaveLength(1));
    expect(putCalls[0]).toEqual({ projectId: "p1", url: "" });
    expect(
      await screen.findByText("Webhook cleared for Arij.")
    ).toBeInTheDocument();
  });

  it("surfaces the server error message", async () => {
    webhookRows = [
      { projectId: "p1", projectName: "Arij", url: "not-a-url" },
    ];
    putShouldFail = true;

    render(<SettingsPage />);

    fireEvent.click(await webhooksSection().findByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "Webhook URL must be an absolute http:// or https:// URL"
      )
    ).toBeInTheDocument();
  });
});
