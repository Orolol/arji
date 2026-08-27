/**
 * Story "UI de configuration globale et par projet".
 *
 * The two properties worth a test here are the ones a screenshot would not
 * catch: a secret field that is never re-displayed and whose blank value means
 * "keep", and the per-server notice naming the providers that will ignore a
 * project-scoped entry. Both are contracts with the API, not styling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { McpServersSection } from "@/components/settings/McpServersSection";
import {
  MCP_SERVER_NAME_MAX_LENGTH,
  MCP_SERVER_SECRET_MASK,
  MCP_SERVER_USAGE_HINT_MAX_LENGTH,
  type McpServerView,
} from "@/lib/mcp/server-limits";

const godot: McpServerView = {
  id: "srv-1",
  projectId: null,
  name: "godot",
  enabled: true,
  transport: "stdio",
  command: "/usr/bin/godot-mcp",
  args: [],
  // What the API really returns: real keys, masked values.
  env: { GODOT_TOKEN: MCP_SERVER_SECRET_MASK },
  url: null,
  headers: {},
  agentTypes: null,
  toolAllowlist: null,
  usageHint: "scenes and nodes",
  lastCheckedAt: "2026-08-27T10:00:00.000Z",
  lastCheckOk: true,
  lastCheckError: null,
  createdAt: "2026-08-27T09:00:00.000Z",
};

function mockFetch(handlers: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      const key = `${method} ${url}`;
      const data = handlers[key] ?? handlers[url] ?? { data: [] };
      return {
        ok: true,
        json: async () => data,
      } as unknown as Response;
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("global scope", () => {
  it("lists global servers with their last health check", async () => {
    mockFetch({ "/api/settings/mcp-servers": { data: [godot] } });
    render(<McpServersSection projectId={null} />);

    expect(await screen.findByText("godot")).toBeInTheDocument();
    expect(screen.getByText("scenes and nodes")).toBeInTheDocument();
    // The badge carries the outcome AND its date, so a stale OK is visible
    // as stale rather than reassuring.
    expect(screen.getByText(/^OK — /)).toBeInTheDocument();
  });

  it("shows a never-tested server as such", async () => {
    mockFetch({
      "/api/settings/mcp-servers": {
        data: [{ ...godot, lastCheckedAt: null, lastCheckOk: null }],
      },
    });
    render(<McpServersSection projectId={null} />);

    expect(await screen.findByText("Never tested")).toBeInTheDocument();
  });

  it("shows a failed check", async () => {
    mockFetch({
      "/api/settings/mcp-servers": {
        data: [{ ...godot, lastCheckOk: false, lastCheckError: "ENOENT" }],
      },
    });
    render(<McpServersSection projectId={null} />);

    expect(await screen.findByText(/^Failed — /)).toBeInTheDocument();
  });

  it("reports the API's error message verbatim", async () => {
    // One error shape for every rejection — a cap breach and an invalid enum
    // land in the same alert.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => ({
        ok: !init?.method || init.method === "GET",
        json: async () =>
          init?.method === "POST"
            ? { error: "usageHint: Too big: expected string to have <=200 characters" }
            : { data: [] },
      })) as unknown as typeof fetch,
    );

    render(<McpServersSection projectId={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add MCP server" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText(/expected string to have <=200 characters/),
    ).toBeInTheDocument();
  });
});

describe("secret fields behave like password fields", () => {
  it("never pre-fills the stored secret when editing", async () => {
    mockFetch({ "/api/settings/mcp-servers": { data: [godot] } });
    render(<McpServersSection projectId={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    const secrets = screen.getByTestId("mcp-server-secrets") as HTMLTextAreaElement;
    // Neither the value nor the mask: rendering "***" here would save that
    // literal string as the secret on the next save.
    expect(secrets.value).toBe("");
    expect(screen.queryByDisplayValue(MCP_SERVER_SECRET_MASK)).toBeNull();
  });

  it("omits the secret map's untouched keys so the server keeps them", async () => {
    const calls = mockFetch({
      "/api/settings/mcp-servers": { data: [godot] },
      "PATCH /api/settings/mcp-servers/srv-1": { data: godot },
    });
    render(<McpServersSection projectId={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByDisplayValue("scenes and nodes"), {
      target: { value: "scenes, nodes and signals" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeDefined();
      // Left blank => the key is absent => the service keeps the stored value.
      expect((patch!.body as { env: Record<string, string> }).env).toEqual({});
      expect((patch!.body as { usageHint: string }).usageHint).toBe(
        "scenes, nodes and signals",
      );
    });
  });

  it("sends a typed secret so it replaces the stored one", async () => {
    const calls = mockFetch({
      "/api/settings/mcp-servers": { data: [godot] },
      "PATCH /api/settings/mcp-servers/srv-1": { data: godot },
    });
    render(<McpServersSection projectId={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByTestId("mcp-server-secrets"), {
      target: { value: "GODOT_TOKEN=brand-new" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect((patch!.body as { env: Record<string, string> }).env).toEqual({
        GODOT_TOKEN: "brand-new",
      });
    });
  });
});

describe("length caps are mirrored on the inputs", () => {
  it("puts the service's maxLength on name and usage hint", async () => {
    mockFetch({ "/api/settings/mcp-servers": { data: [] } });
    render(<McpServersSection projectId={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add MCP server" }));

    const form = screen.getByTestId("mcp-server-form");
    const inputs = within(form).getAllByRole("textbox");
    const maxLengths = inputs.map((i) => i.getAttribute("maxlength"));

    // The same constants the service validates against — a second copy here is
    // how a form starts accepting what the API refuses.
    expect(maxLengths).toContain(String(MCP_SERVER_NAME_MAX_LENGTH));
    expect(maxLengths).toContain(String(MCP_SERVER_USAGE_HINT_MAX_LENGTH));
  });
});

describe("project scope", () => {
  const projectPayload = {
    data: {
      servers: [{ ...godot, id: "srv-2", projectId: "proj-1", name: "playwright" }],
      inherited: [{ ...godot, shadowed: false }],
      unsupportedProviders: ["agy", "oh-my-pi"],
    },
  };

  it("separates local servers from inherited globals", async () => {
    mockFetch({ "/api/projects/proj-1/mcp-servers": projectPayload });
    render(<McpServersSection projectId="proj-1" />);

    expect(await screen.findByTestId("mcp-server-playwright")).toBeInTheDocument();
    const inheritedRow = screen.getByTestId("mcp-inherited-godot");
    expect(within(inheritedRow).getByText("global")).toBeInTheDocument();
    // Inherited entries are read-only here: no Edit/Delete on them.
    expect(within(inheritedRow).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(inheritedRow).queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("names the providers that will not honour a project-scoped server", async () => {
    mockFetch({ "/api/projects/proj-1/mcp-servers": projectPayload });
    render(<McpServersSection projectId="proj-1" />);

    const notice = await screen.findByTestId("mcp-server-unsupported-playwright");
    expect(notice.textContent).toContain("agy");
    expect(notice.textContent).toContain("oh-my-pi");
    expect(notice.textContent).toMatch(/global servers only/);
  });

  it("does not show that notice in the global scope", async () => {
    mockFetch({ "/api/settings/mcp-servers": { data: [godot] } });
    render(<McpServersSection projectId={null} />);

    await screen.findByText("godot");
    // A GLOBAL server IS honoured by every provider, so the warning would be
    // wrong here.
    expect(screen.queryByTestId("mcp-server-unsupported-godot")).toBeNull();
  });

  it("disables an inherited global for this project", async () => {
    const calls = mockFetch({
      "/api/projects/proj-1/mcp-servers": projectPayload,
      "POST /api/projects/proj-1/mcp-servers/shadow": { data: godot },
    });
    render(<McpServersSection projectId="proj-1" />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Disable for this project" }),
    );

    await waitFor(() => {
      const shadow = calls.find((c) => c.url.endsWith("/shadow"));
      expect(shadow?.body).toEqual({ globalServerId: "srv-1" });
    });
  });

  it("marks an already-overridden global and drops its disable button", async () => {
    mockFetch({
      "/api/projects/proj-1/mcp-servers": {
        data: { ...projectPayload.data, inherited: [{ ...godot, shadowed: true }] },
      },
    });
    render(<McpServersSection projectId="proj-1" />);

    const row = await screen.findByTestId("mcp-inherited-godot");
    expect(within(row).getByText("overridden here")).toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: "Disable for this project" }),
    ).toBeNull();
  });
});

describe("connection test", () => {
  it("reports the tools the server exposed", async () => {
    mockFetch({
      "/api/settings/mcp-servers": { data: [godot] },
      "POST /api/settings/mcp-servers/srv-1/test": {
        data: { ok: true, toolCount: 2, toolNames: ["list_nodes", "run_scene"], error: null },
      },
    });
    render(<McpServersSection projectId={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));

    expect(await screen.findByText(/Connected — 2 tool\(s\)/)).toBeInTheDocument();
    expect(screen.getByTestId("mcp-servers-message").textContent).toContain(
      "list_nodes",
    );
  });

  it("reports a readable failure", async () => {
    mockFetch({
      "/api/settings/mcp-servers": { data: [godot] },
      "POST /api/settings/mcp-servers/srv-1/test": {
        data: { ok: false, toolCount: 0, toolNames: [], error: "spawn ENOENT" },
      },
    });
    render(<McpServersSection projectId={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));

    expect(await screen.findByText(/Failed — spawn ENOENT/)).toBeInTheDocument();
  });
});
