/**
 * Settings → Intégrations — "Se connecter avec GitHub" (OAuth Device Flow).
 *
 * The routes have their own suite (`github-device-flow-routes.test.ts`); this
 * one covers what the BROWSER adds: starting a flow, showing the code, polling
 * at the cadence the server dictates, surviving `slow_down`, surfacing the
 * terminal refusals (expired / denied / unconfigured) with a way back, and
 * disconnecting all the way to the unconfigured state.
 *
 * Time is faked throughout because the poll loop is a chain of `setTimeout`s —
 * a real-time run would trade six seconds of wall clock for nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import IntegrationsSettingsPage from "@/app/settings/integrations/page";

interface StubResponse {
  status: number;
  body: unknown;
}

const PENDING: StubResponse = {
  status: 200,
  body: { data: { state: "pending", interval: 1 } },
};

const SUCCESS: StubResponse = {
  status: 200,
  body: {
    data: {
      state: "success",
      login: "octocat",
      scopes: ["repo", "read:user"],
      obtainedAt: "2026-09-05T10:00:00.000Z",
      tokenSource: "oauth_device",
    },
  },
};

const STARTED: StubResponse = {
  status: 200,
  body: {
    data: {
      handle: "gh-device-handle-abc",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      interval: 1,
      expiresIn: 900,
    },
  },
};

let settingsData: Record<string, unknown>;
let startResponse: StubResponse;
let pollQueue: StubResponse[];
let validateResponse: StubResponse;
let patchCalls: Array<Record<string, unknown>>;
let pollBodies: Array<Record<string, unknown>>;
let cancelBodies: Array<Record<string, unknown>>;
let startCalls: number;

function stub({ status, body }: StubResponse) {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * Flush the fetch/`.json()`/setState chains without moving the clock.
 *
 * `waitFor` and `findBy*` are deliberately NOT used anywhere in this file:
 * they poll on `setTimeout`, which is faked here, so they would spin until the
 * test times out. Every stub below resolves immediately, so draining the
 * microtask queue inside `act` is both sufficient and deterministic.
 */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

/** Move the clock, letting every timer AND the promises it starts resolve. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Render the tab and wait for its `GET /api/settings` read to land. */
async function renderIntegrations() {
  render(<IntegrationsSettingsPage />);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();

  settingsData = {};
  startResponse = STARTED;
  pollQueue = [];
  validateResponse = {
    status: 200,
    body: { data: { valid: true, login: "octocat" } },
  };
  patchCalls = [];
  pollBodies = [];
  cancelBodies = [];
  startCalls = 0;

  global.fetch = vi.fn((url: string, opts?: RequestInit) => {
    const method = opts?.method ?? "GET";

    if (url === "/api/auth/github/device/start") {
      startCalls += 1;
      return Promise.resolve(stub(startResponse));
    }

    if (url === "/api/auth/github/device/poll") {
      pollBodies.push(JSON.parse((opts?.body as string) ?? "{}"));
      return Promise.resolve(stub(pollQueue.shift() ?? PENDING));
    }

    if (url === "/api/auth/github/device/cancel") {
      cancelBodies.push(JSON.parse((opts?.body as string) ?? "{}"));
      return Promise.resolve(
        stub({ status: 200, body: { data: { cancelled: true } } }),
      );
    }

    if (url === "/api/settings" && method === "PATCH") {
      patchCalls.push(JSON.parse(opts?.body as string));
      return Promise.resolve(stub({ status: 200, body: { data: { updated: true } } }));
    }

    if (url === "/api/settings/github/validate") {
      return Promise.resolve(stub(validateResponse));
    }

    if (url === "/api/settings/webhooks") {
      return Promise.resolve(stub({ status: 200, body: { data: { webhooks: [] } } }));
    }

    return Promise.resolve(stub({ status: 200, body: { data: settingsData } }));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Settings → Intégrations — connexion GitHub par Device Flow", () => {
  it("connects end to end without a token ever being pasted", async () => {
    pollQueue = [PENDING, SUCCESS];
    await renderIntegrations();

    fireEvent.click(screen.getByTestId("github-connect"));
    await settle();

    // The code the user types on github.com, and where to type it.
    expect(screen.getByTestId("github-device-code")).toHaveTextContent("WDJB-MJHT");
    expect(screen.getByTestId("github-device-link")).toHaveAttribute(
      "href",
      "https://github.com/login/device",
    );

    await advance(1000); // pending
    expect(screen.getByTestId("github-device-flow")).toBeInTheDocument();

    await advance(1000); // success
    expect(screen.getByTestId("github-connected")).toHaveTextContent(
      "Connecté en tant que octocat",
    );

    // The whole point of the epic: nothing was typed into the PAT field.
    expect(screen.getByLabelText("GitHub PAT")).toHaveValue("");
    // The card writes no settings itself — the poll route already did.
    expect(patchCalls).toHaveLength(0);
  });

  it("sends only the opaque handle when polling, never a device code", async () => {
    pollQueue = [SUCCESS];
    await renderIntegrations();

    fireEvent.click(screen.getByTestId("github-connect"));
    await settle();
    await advance(1000);

    expect(pollBodies).toHaveLength(1);
    expect(pollBodies[0]).toEqual({ handle: "gh-device-handle-abc" });
  });

  it("waits the raised cadence GitHub asks for after slow_down", async () => {
    pollQueue = [
      { status: 200, body: { data: { state: "slow_down", interval: 6 } } },
      SUCCESS,
    ];
    await renderIntegrations();

    fireEvent.click(screen.getByTestId("github-connect"));
    await settle();

    await advance(1000);
    expect(pollBodies).toHaveLength(1);

    // The original 1s cadence would have fired four more times by now.
    await advance(4000);
    expect(pollBodies).toHaveLength(1);

    await advance(2000);
    expect(pollBodies).toHaveLength(2);
  });

  it("reports an expired code with a way to start over", async () => {
    pollQueue = [
      {
        status: 410,
        body: {
          error: "This GitHub sign-in expired. Start it again.",
          code: "DEVICE_FLOW_EXPIRED",
        },
      },
    ];
    await renderIntegrations();

    fireEvent.click(screen.getByTestId("github-connect"));
    await settle();
    await advance(1000);

    const failure = screen.getByTestId("github-flow-error");
    expect(failure).toHaveTextContent("This GitHub sign-in expired. Start it again.");
    expect(screen.queryByTestId("github-device-code")).not.toBeInTheDocument();

    // Réessayer really restarts: a second `start` call, a fresh code panel.
    pollQueue = [PENDING];
    fireEvent.click(screen.getByTestId("github-flow-retry"));
    await settle();

    expect(startCalls).toBe(2);
    expect(screen.getByTestId("github-device-code")).toHaveTextContent("WDJB-MJHT");
  });

  it("reports a refused authorization with a way to start over", async () => {
    pollQueue = [
      {
        status: 403,
        body: {
          error: "The GitHub sign-in was refused. Start it again to retry.",
          code: "DEVICE_FLOW_DENIED",
        },
      },
    ];
    await renderIntegrations();

    fireEvent.click(screen.getByTestId("github-connect"));
    await settle();
    await advance(1000);

    expect(screen.getByTestId("github-flow-error")).toHaveTextContent(
      "The GitHub sign-in was refused. Start it again to retry.",
    );
    expect(screen.getByTestId("github-flow-retry")).toBeInTheDocument();
  });

  it("keeps polling through an unreachable GitHub, then gives up visibly", async () => {
    const unreachable: StubResponse = {
      status: 503,
      body: { error: "Could not reach GitHub.", code: "GITHUB_UNREACHABLE" },
    };
    pollQueue = [unreachable, unreachable, unreachable, unreachable, unreachable];
    await renderIntegrations();

    fireEvent.click(screen.getByTestId("github-connect"));
    await settle();

    // The first four are survivable: the device code is still good.
    await advance(4000);
    expect(screen.getByTestId("github-device-flow")).toBeInTheDocument();

    await advance(1000);
    expect(screen.getByTestId("github-flow-error")).toHaveTextContent(
      "Could not reach GitHub.",
    );
  });

  it("surfaces an unconfigured OAuth App and leaves the manual PAT field usable", async () => {
    startResponse = {
      status: 400,
      body: {
        error:
          "The Arij GitHub OAuth App is not configured yet. Paste a personal access token instead.",
        code: "CLIENT_ID_NOT_CONFIGURED",
      },
    };
    await renderIntegrations();

    fireEvent.click(screen.getByTestId("github-connect"));
    await settle();

    expect(screen.getByTestId("github-flow-error")).toHaveTextContent(
      "The Arij GitHub OAuth App is not configured yet.",
    );
    // The fallback the message points at is right there, and still works.
    expect(screen.getByLabelText("GitHub PAT")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Token" })).toBeInTheDocument();
  });

  it("stops polling when the user cancels", async () => {
    await renderIntegrations();

    fireEvent.click(screen.getByTestId("github-connect"));
    await settle();
    await advance(1000);
    expect(pollBodies).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    await advance(5000);

    expect(pollBodies).toHaveLength(1);
    expect(screen.queryByTestId("github-device-flow")).not.toBeInTheDocument();
    expect(screen.getByTestId("github-connect")).toBeInTheDocument();
  });

  it("tells the server to drop the flow, not just its own timers", async () => {
    await renderIntegrations();

    fireEvent.click(screen.getByTestId("github-connect"));
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    await settle();

    // Stopping the timers only stops THIS tab from asking. The server still
    // holds the device code, and a tick already in flight would come back with
    // a real token and connect the account the user just walked away from.
    expect(cancelBodies).toEqual([{ handle: "gh-device-handle-abc" }]);
  });

  it("releases the flow when the user gives up and pastes a PAT instead", async () => {
    await renderIntegrations();

    fireEvent.click(screen.getByTestId("github-connect"));
    await settle();

    fireEvent.change(screen.getByLabelText("GitHub PAT"), {
      target: { value: "ghp_pasted_instead" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Token" }));
    await settle();

    expect(cancelBodies).toEqual([{ handle: "gh-device-handle-abc" }]);
  });

  it("releases the flow when the card unmounts mid sign-in", async () => {
    const { unmount } = render(<IntegrationsSettingsPage />);
    await settle();

    fireEvent.click(screen.getByTestId("github-connect"));
    await settle();

    unmount();
    await settle();

    // A device code held for a page nobody is on is a code held for nothing.
    expect(cancelBodies).toEqual([{ handle: "gh-device-handle-abc" }]);
  });

  it("does not release anything once the flow has finished on its own", async () => {
    pollQueue = [SUCCESS];
    await renderIntegrations();

    fireEvent.click(screen.getByTestId("github-connect"));
    await settle();
    await advance(1000);

    expect(screen.getByTestId("github-connected")).toBeInTheDocument();
    // The server settled the slot when it wrote the token; a release now would
    // be a request about a flow nobody holds.
    expect(cancelBodies).toHaveLength(0);
  });
});

describe("Settings → Intégrations — état connecté et déconnexion", () => {
  it("names the account from github_oauth_meta on load", async () => {
    settingsData = {
      github_pat: { hasToken: true },
      github_oauth_meta: {
        login: "octocat",
        scopes: ["repo", "read:user"],
        obtainedAt: "2026-09-05T10:00:00.000Z",
        tokenSource: "oauth_device",
      },
    };
    await renderIntegrations();

    const panel = screen.getByTestId("github-connected");
    expect(panel).toHaveTextContent("Connecté en tant que octocat");
    expect(panel).toHaveTextContent("repo, read:user");
    expect(screen.queryByTestId("github-connect")).not.toBeInTheDocument();
  });

  it("ignores a github_oauth_meta row of the wrong shape", async () => {
    settingsData = {
      github_pat: { hasToken: true },
      github_oauth_meta: { login: "", tokenSource: "carrier-pigeon" },
    };
    await renderIntegrations();

    // Falls back to the tokenless indicator rather than half-rendering a
    // connection card from a hand-edited row.
    expect(screen.queryByText(/Connecté en tant que/)).not.toBeInTheDocument();
    expect(screen.getByTestId("github-connected")).toHaveTextContent(
      "A GitHub token is already saved for this workspace.",
    );
  });

  it("clears both keys on Déconnecter and returns to the unconfigured state", async () => {
    settingsData = {
      github_pat: { hasToken: true },
      github_oauth_meta: {
        login: "octocat",
        scopes: ["repo"],
        obtainedAt: "2026-09-05T10:00:00.000Z",
        tokenSource: "oauth_device",
      },
    };
    await renderIntegrations();

    expect(screen.getByTestId("github-connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Déconnecter" }));
    await settle();

    expect(patchCalls).toEqual([{ github_pat: "", github_oauth_meta: null }]);
    expect(screen.getByTestId("github-connect")).toBeInTheDocument();
    expect(screen.queryByTestId("github-connected")).not.toBeInTheDocument();
    expect(screen.queryByText(/Connecté en tant que/)).not.toBeInTheDocument();
  });

  it("offers Déconnecter for a token saved before this epic, with no meta", async () => {
    settingsData = { github_pat: { hasToken: true } };
    await renderIntegrations();

    expect(screen.getByTestId("github-connected")).toHaveTextContent(
      "A GitHub token is already saved for this workspace.",
    );
    expect(screen.getByRole("button", { name: "Déconnecter" })).toBeInTheDocument();
  });

  it("keeps a disconnect failure visible instead of faking a clean state", async () => {
    settingsData = { github_pat: { hasToken: true } };
    await renderIntegrations();

    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (url: string, opts?: RequestInit) => {
        if (url === "/api/settings" && opts?.method === "PATCH") {
          return Promise.resolve(
            stub({ status: 500, body: { error: "Save failed: permission denied" } }),
          );
        }
        return Promise.resolve(stub({ status: 200, body: { data: settingsData } }));
      },
    );

    expect(screen.getByTestId("github-connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Déconnecter" }));
    await settle();

    expect(screen.getByText("Save failed: permission denied")).toBeInTheDocument();
    expect(screen.getByTestId("github-connected")).toBeInTheDocument();
  });
});

describe("Settings → Intégrations — le PAT manuel reste le repli", () => {
  it("records tokenSource manual alongside the token", async () => {
    await renderIntegrations();

    fireEvent.change(screen.getByLabelText("GitHub PAT"), {
      target: { value: "ghp_manual" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Token" }));
    await settle();

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].github_pat).toBe("ghp_manual");
    expect(patchCalls[0].github_oauth_meta).toMatchObject({
      login: "octocat",
      tokenSource: "manual",
    });
    expect(screen.getByTestId("github-connected")).toHaveTextContent(
      "Connecté en tant que octocat",
    );
  });

  it("still saves the token when the identity lookup fails, clearing stale meta", async () => {
    settingsData = {
      github_pat: { hasToken: true },
      github_oauth_meta: {
        login: "someone-else",
        scopes: ["repo"],
        obtainedAt: "2026-09-05T10:00:00.000Z",
        tokenSource: "oauth_device",
      },
    };
    validateResponse = {
      status: 401,
      body: { error: "GitHub rejected the token. Verify it and try again." },
    };
    await renderIntegrations();

    fireEvent.change(screen.getByLabelText("GitHub PAT"), {
      target: { value: "ghp_unverifiable" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Token" }));
    await settle();

    expect(patchCalls).toHaveLength(1);
    // The token is saved regardless; the meta is nulled rather than left
    // claiming a connection as @someone-else.
    expect(patchCalls[0]).toEqual({
      github_pat: "ghp_unverifiable",
      github_oauth_meta: null,
    });
    expect(screen.queryByText(/Connecté en tant que/)).not.toBeInTheDocument();
  });
});
