import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { REFINEMENT_ACTIONS, parseRefinementActions } from "@/lib/refinement/options";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  return createTestDb();
});
vi.mock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));

const { db } = await import("@/lib/db");
const { projects, agentSessions, epics } = await import("@/lib/db/schema");
const { requireMcpToken } = await import("@/lib/mcp/http-auth");
const { mintMcpToken } = await import("@/lib/mcp/token-store");
const { POST: setPriority } = await import("@/app/api/mcp/set-priority/route");
let count = 0;
let sessionId: string;
let ticketId: string;
let token: string;

function request(tool: string, body = {}) {
  return new NextRequest(`http://localhost/api/mcp/${tool.replaceAll("_", "-")}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  const projectId = `permissions-${++count}`;
  sessionId = `${projectId}-session`;
  ticketId = `${projectId}-ticket`;
  db.insert(projects).values({ id: projectId, name: "Permissions" }).run();
  db.insert(agentSessions).values({ id: sessionId, projectId, agentType: "refinement", refinementActions: '["grooming"]' }).run();
  db.insert(epics).values({ id: ticketId, projectId, title: "Target", priority: 2, status: "backlog" }).run();
  token = mintMcpToken({ sessionId, projectId, agentType: "refinement" });
});

describe("REfinment 2 — persisted MCP permissions", () => {
  it.each(REFINEMENT_ACTIONS)("allows only the selected $id tools", (selected) => {
    db.update(agentSessions).set({ refinementActions: JSON.stringify([selected.id]) }).where(eq(agentSessions.id, sessionId)).run();
    for (const action of REFINEMENT_ACTIONS) {
      for (const tool of action.tools) {
        const result = requireMcpToken(request(tool));
        if (action.id === selected.id) expect(result).not.toBeInstanceOf(NextResponse);
        else expect((result as NextResponse).status).toBe(403);
      }
    }
    expect((requireMcpToken(request("create_bug")) as NextResponse).status).toBe(403);
    expect(requireMcpToken(request("get_ticket"))).not.toBeInstanceOf(NextResponse);
    expect(requireMcpToken(request("report_friction"))).not.toBeInstanceOf(NextResponse);
  });

  it("refuses a disabled mutation without changing the ticket; enabling it permits the write", async () => {
    const body = { ticket_id: ticketId, priority: 0, reason: "Deprioritize optional work" };
    const denied = await setPriority(request("set_priority", body));
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("REFINEMENT_ACTION_DISABLED");
    expect(db.select().from(epics).where(eq(epics.id, ticketId)).get()?.priority).toBe(2);
    db.update(agentSessions).set({ refinementActions: '["priorities"]' }).where(eq(agentSessions.id, sessionId)).run();
    const allowed = await setPriority(request("set_priority", body));
    expect(allowed.status).toBe(200);
    expect(db.select().from(epics).where(eq(epics.id, ticketId)).get()?.priority).toBe(0);
  });

  it("preserves restrictions for newly minted tokens and rejects malformed persisted actions", () => {
    const row = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get()!;
    token = mintMcpToken({ sessionId, projectId: row.projectId, agentType: "refinement" });
    expect((requireMcpToken(request("merge_tickets")) as NextResponse).status).toBe(403);
    db.update(agentSessions).set({ refinementActions: "invalid" }).where(eq(agentSessions.id, sessionId)).run();
    expect((requireMcpToken(request("post_comment")) as NextResponse).status).toBe(403);
    expect(parseRefinementActions('["unknown"]')).toEqual([]);
  });

  it("preserves legacy NULL actions and leaves other session roles unaffected", () => {
    db.update(agentSessions).set({ refinementActions: null }).where(eq(agentSessions.id, sessionId)).run();
    expect(requireMcpToken(request("merge_tickets"))).not.toBeInstanceOf(NextResponse);
    const row = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get()!;
    db.update(agentSessions).set({ refinementActions: '["grooming"]' }).where(eq(agentSessions.id, sessionId)).run();
    token = mintMcpToken({ sessionId, projectId: row.projectId, agentType: "build" });
    expect(requireMcpToken(request("set_priority"))).not.toBeInstanceOf(NextResponse);
  });
});
