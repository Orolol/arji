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
      // Left blank => the key is ABSENT from the patch => the service keeps the
      // stored value. Sending `{}` instead is not a weaker version of this, it
      // is the opposite: `mergeSecretMap` walks the patch it is handed, so an
      // empty map erases every stored secret.
      expect((patch!.body as Record<string, unknown>)).not.toHaveProperty("env");
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

/**
 * PATCH is a MERGE, so every field the form stops rendering has to be cleared
 * explicitly or it survives into the merged row. Two things break otherwise:
 * the row goes transport-inconsistent and the API rejects the save naming a
 * field the form is no longer showing, and the abandoned side's credentials
 * stay live on a server that no longer uses them.
 */
describe("switching an existing server's transport", () => {
  const transportSelect = () => screen.getByTestId("mcp-server-transport");

  it("stdio -> http clears command and args", async () => {
    const calls = mockFetch({
      "/api/settings/mcp-servers": { data: [godot] },
      "PATCH /api/settings/mcp-servers/srv-1": { data: godot },
    });
    render(<McpServersSection projectId={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(transportSelect(), { target: { value: "http" } });
    fireEvent.change(screen.getByTestId("mcp-server-url"), {
      target: { value: "https://godot.local/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      const body = patch?.body as Record<string, unknown>;
      expect(body?.url).toBe("https://godot.local/mcp");
      // Left behind, these make the merged row transport-inconsistent and the
      // save comes back "command is not allowed on an http server" — naming a
      // field the form has just stopped rendering.
      expect(body?.command).toBeNull();
      expect(body?.args).toBeNull();
    });
  });

  it("http -> stdio clears the url", async () => {
    const remote: McpServerView = {
      ...godot,
      transport: "http",
      command: null,
      // `[]`, not null: toView coerces a NULL args column to an empty array, so
      // this is the shape the API can actually return.
      args: [],
      url: "https://godot.local/mcp",
      env: {},
      headers: { Authorization: MCP_SERVER_SECRET_MASK },
    };
    const calls = mockFetch({
      "/api/settings/mcp-servers": { data: [remote] },
      "PATCH /api/settings/mcp-servers/srv-1": { data: remote },
    });
    render(<McpServersSection projectId={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(transportSelect(), { target: { value: "stdio" } });
    fireEvent.change(screen.getByTestId("mcp-server-command"), {
      target: { value: "/usr/bin/godot-mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      const body = patch?.body as Record<string, unknown>;
      expect(body?.command).toBe("/usr/bin/godot-mcp");
      expect(body?.url).toBeNull();
    });
  });

  it("drops the abandoned transport's secrets, which are now dead config", async () => {
    const calls = mockFetch({
      "/api/settings/mcp-servers": { data: [godot] },
      "PATCH /api/settings/mcp-servers/srv-1": { data: godot },
    });
    render(<McpServersSection projectId={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(transportSelect(), { target: { value: "http" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      const body = patch?.body as Record<string, unknown>;
      // `env` belonged to the stdio side. An empty map is the ERASE signal
      // here, and erasing is what we want — the opposite of the blank-textarea
      // case, where the key is omitted so the stored value survives.
      expect(body?.env).toEqual({});
      // The user typed no header, so the http side is left untouched for them
      // to fill in.
      expect(body).not.toHaveProperty("headers");
    });
  });

  it("leaves both sides alone on an ordinary edit that keeps the transport", async () => {
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
      const body = patch?.body as Record<string, unknown>;
      expect(body?.usageHint).toBe("scenes, nodes and signals");
      // The clearing above must fire on an actual SWITCH only. A hint edit that
      // wiped the command would be the same class of bug, one field over.
      expect(body).not.toHaveProperty("env");
      expect(body).not.toHaveProperty("headers");
      expect(body?.command).toBe("/usr/bin/godot-mcp");
    });
  });
});

/**
 * Both columns are load-bearing and both are silent when wrong: an
 * `agent_types` of ["reviewer"] instead of a real agent type means the server
 * never injects anywhere, with no error at any layer. So they need to be
 * settable AND visible.
 */
describe("agent types and tool allowlist", () => {
  const scoped: McpServerView = {
    ...godot,
    agentTypes: ["ticket_build", "review_security"],
    toolAllowlist: ["list_nodes"],
  };

  it("shows both on the row so a typo is visible", async () => {
    mockFetch({ "/api/settings/mcp-servers": { data: [scoped] } });
    render(<McpServersSection projectId={null} />);

    const row = await screen.findByTestId("mcp-server-godot");
    expect(
      within(row).getByTestId("mcp-server-agent-types-godot"),
    ).toHaveTextContent("ticket_build, review_security");
    expect(within(row).getByTestId("mcp-server-tools-godot")).toHaveTextContent(
      "list_nodes",
    );
  });

  it("shows the stored secret KEYS, so a credential-less row is visible", async () => {
    mockFetch({ "/api/settings/mcp-servers": { data: [godot] } });
    render(<McpServersSection projectId={null} />);

    const row = await screen.findByTestId("mcp-server-godot");
    const badge = within(row).getByTestId("mcp-server-secret-keys-godot");
    expect(badge).toHaveTextContent("GODOT_TOKEN");
    // Keys only. The value is masked by the API and must not appear anywhere.
    expect(badge).not.toHaveTextContent(MCP_SERVER_SECRET_MASK);
  });

  it("shows no secrets badge on a row that stores none", async () => {
    // What "Disable for this project" produces: the global's shape, none of
    // its credentials. The one-click Enable sits right next to it, so the
    // absence has to be visible rather than discovered at spawn time.
    mockFetch({
      "/api/settings/mcp-servers": { data: [{ ...godot, env: {}, enabled: false }] },
    });
    render(<McpServersSection projectId={null} />);

    const row = await screen.findByTestId("mcp-server-godot");
    expect(within(row).queryByTestId("mcp-server-secret-keys-godot")).toBeNull();
  });

  it("reads the http side's keys for an http server", async () => {
    mockFetch({
      "/api/settings/mcp-servers": {
        data: [
          {
            ...godot,
            transport: "http",
            command: null,
            args: [],
            url: "https://godot.local/mcp",
            env: {},
            headers: { Authorization: MCP_SERVER_SECRET_MASK },
          },
        ],
      },
    });
    render(<McpServersSection projectId={null} />);

    const row = await screen.findByTestId("mcp-server-godot");
    expect(
      within(row).getByTestId("mcp-server-secret-keys-godot"),
    ).toHaveTextContent("Authorization");
  });

  it("says nothing on a row that restricts neither", async () => {
    mockFetch({ "/api/settings/mcp-servers": { data: [godot] } });
    render(<McpServersSection projectId={null} />);

    const row = await screen.findByTestId("mcp-server-godot");
    expect(within(row).queryByTestId("mcp-server-agent-types-godot")).toBeNull();
    expect(within(row).queryByTestId("mcp-server-tools-godot")).toBeNull();
  });

  it("round-trips the stored values through the form", async () => {
    const calls = mockFetch({
      "/api/settings/mcp-servers": { data: [scoped] },
      "PATCH /api/settings/mcp-servers/srv-1": { data: scoped },
    });
    render(<McpServersSection projectId={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const types = screen.getByTestId("mcp-server-agent-types") as HTMLTextAreaElement;
    expect(types.value).toBe("ticket_build\nreview_security");

    fireEvent.change(types, { target: { value: "ticket_build\nchat" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect((patch?.body as Record<string, unknown>)?.agentTypes).toEqual([
        "ticket_build",
        "chat",
      ]);
    });
  });

  it("sends null, not [], when the box is emptied", async () => {
    const calls = mockFetch({
      "/api/settings/mcp-servers": { data: [scoped] },
      "PATCH /api/settings/mcp-servers/srv-1": { data: scoped },
    });
    render(<McpServersSection projectId={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByTestId("mcp-server-agent-types"), {
      target: { value: "  \n " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      const body = patch?.body as Record<string, unknown>;
      // NULL is "every agent type". An empty ARRAY matches nothing, which would
      // silently keep the server out of every session — the exact failure the
      // row badges exist to make visible.
      expect(body?.agentTypes).toBeNull();
      expect(body?.toolAllowlist).toEqual(["list_nodes"]);
    });
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

  /**
   * "Disable for this project" writes a PROJECT row, and a project row cannot
   * reach a user-global registry — so on oh-my-pi and agy the global keeps
   * loading. That asymmetry is deliberate on the resolution side (a row those
   * CLIs cannot see must not suppress a global they can), which makes saying so
   * on screen the only thing standing between the user and a button that
   * silently does nothing on half the providers.
   */
  it("warns that disabling here will not reach the user-global providers", async () => {
    mockFetch({ "/api/projects/proj-1/mcp-servers": projectPayload });
    render(<McpServersSection projectId="proj-1" />);

    const note = await screen.findByTestId("mcp-inherited-partial-godot");
    expect(note).toHaveTextContent(/will not affect agy, oh-my-pi/);
    // And it names the recourse that DOES work everywhere.
    expect(note).toHaveTextContent(/disable it globally/);
  });

  it("drops the warning when every provider honours a project row", async () => {
    mockFetch({
      "/api/projects/proj-1/mcp-servers": {
        data: { ...projectPayload.data, unsupportedProviders: [] },
      },
    });
    render(<McpServersSection projectId="proj-1" />);

    await screen.findByTestId("mcp-inherited-godot");
    expect(screen.queryByTestId("mcp-inherited-partial-godot")).toBeNull();
  });

  it("marks an already-overridden global and drops its disable button", async () => {
    mockFetch({
      "/api/projects/proj-1/mcp-servers": {
        data: { ...projectPayload.data, inherited: [{ ...godot, shadowed: true }] },
      },
    });
    render(<McpServersSection projectId="proj-1" />);

    const row = await screen.findByTestId("mcp-inherited-godot");
    // Qualified, not a bare "overridden here": the override is a PROJECT row,
    // and a project row cannot reach a user-global registry, so those two CLIs
    // keep loading the global. An unqualified badge would state the opposite of
    // what happens on half the providers.
    expect(
      within(row).getByText("overridden here — except on agy, oh-my-pi"),
    ).toBeInTheDocument();
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
