/** Real HTTP handlers, resolver and migrated SQLite; no CLI is launched. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  return { ...createTestDb(), ensureDbReady: vi.fn() };
});
vi.mock("@/lib/chat/persistent-runner", () => ({
  getPersistentChatSessionState: vi.fn(() => "cold"),
  restartPersistentChatSession: vi.fn(),
}));

import { sqlite } from "@/lib/db";
import { CompositeAgentUnusableError } from "@/lib/agent-config/agent-resolution";
import { withAgentResolutionErrors } from "@/lib/api/agent-resolution-response";
import { POST as updateSpec } from "@/app/api/projects/[projectId]/spec/update/route";
import { errorResponse } from "@/lib/api/route-helpers";
import { GET as resumable } from "@/app/api/projects/[projectId]/sessions/resumable/route";
import { GET as reviewResolution } from "@/app/api/projects/[projectId]/review-resolution/route";
import { POST as chat } from "@/app/api/projects/[projectId]/chat/stream/route";
import { PATCH as patchConversation } from "@/app/api/projects/[projectId]/conversations/[conversationId]/route";

const params = { params: Promise.resolve({ projectId: "p", conversationId: "chat" }) };
const unusableMessage = new CompositeAgentUnusableError("c", "Fallback list").message;
function emptyComposite() {
  // An ordinary roster deletion empties the list through the real FK cascade.
  sqlite.prepare("DELETE FROM named_agents WHERE id = 'm'").run();
}

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM projects; DELETE FROM agent_provider_defaults;
    DELETE FROM composite_agent_members; DELETE FROM named_agents; DELETE FROM settings;
    INSERT INTO projects(id,name,git_repo_path) VALUES('p','Project','/tmp/composite-route-repo');
    INSERT INTO named_agents(id,name,provider,model,kind) VALUES
      ('m','Member','agy','model-one','simple'),
      ('c','Fallback list','composite','','composite');
    INSERT INTO composite_agent_members(id,composite_id,member_id,position) VALUES('cm','c','m',0);
    INSERT INTO chat_conversations(id,project_id,provider,named_agent_id)
      VALUES('chat','p','agy','c');
    INSERT INTO agent_sessions(id,project_id,agent_type,status,provider,named_agent_id,cli_session_id)
      VALUES('run','p','build','completed','agy','m','cli-run'),
      ('other','p','build','completed','claude-code',NULL,'other-cli-run');
  `);
});

describe("empty composite HTTP boundary", () => {
  it.each(["&agentType=build", ""])("resumable returns members, then an actionable 400 after deletion (%s)", async (role) => {
    const request = () => new NextRequest(`http://localhost/api/projects/p/sessions/resumable?namedAgentId=c${role}`);
    const before = await resumable(request(), params);
    expect(before.status).toBe(200);
    expect((await before.json()).data.map((row: { id: string }) => row.id)).toEqual(["run"]);
    emptyComposite();
    const after = await resumable(request(), params);
    expect(after.status).toBe(400);
    expect(await after.json()).toEqual({ error: unusableMessage });
  });

  it("review resolution returns an actionable 400 for an explicit empty composite", async () => {
    emptyComposite();
    const response = await reviewResolution(new NextRequest(
      "http://localhost/api/projects/p/review-resolution?namedAgentId=c&agentType=review_code",
    ), params);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: unusableMessage });
  });

  it("chat refuses an emptied conversation agent before storing a message or starting a stream", async () => {
    emptyComposite();
    const response = await chat(new NextRequest("http://localhost/api/projects/p/chat/stream", {
      method: "POST", body: JSON.stringify({ content: "Hello", conversationId: "chat" }),
    }), params);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: unusableMessage });
    expect(sqlite.prepare("SELECT count(*) AS n FROM chat_messages").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM agent_sessions").get()).toEqual({ n: 2 });
  });

  it("an indirect spec-update dispatch returns the same actionable 400", async () => {
    emptyComposite();
    const response = await updateSpec(new NextRequest("http://localhost/api/projects/p/spec/update", {
      method: "POST", body: JSON.stringify({ namedAgentId: "c" }),
    }), params);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: unusableMessage });
    expect(sqlite.prepare("SELECT count(*) AS n FROM agent_sessions").get()).toEqual({ n: 2 });
  });

  it("the boundary preserves successful responses and rethrows unrelated failures", async () => {
    const response = new Response("data: hello\n\n", { headers: { "Content-Type": "text/event-stream" } });
    expect(await withAgentResolutionErrors(async () => response)()).toBe(response);
    const error = new Error("Unexpected storage failure");
    await expect(withAgentResolutionErrors(async () => { throw error; })()).rejects.toBe(error);
  });

  it("shared catch response classifies composite errors as 400 and preserves unexpected failures", async () => {
    const response = errorResponse(new CompositeAgentUnusableError("c", "Fallback list"), "Dispatch failed");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: unusableMessage });
    expect(errorResponse(new Error("unexpected"), "Dispatch failed").status).toBe(500);
  });
});

describe("conversation provider persistence", () => {
  it.each(["c", "m"])("PATCH %s keeps a real provider, including after the selected agent is deleted", async (id) => {
    sqlite.exec("UPDATE chat_conversations SET provider='claude-code', named_agent_id=NULL");
    const response = await patchConversation(new NextRequest("http://localhost/api/projects/p/conversations/chat", {
      method: "PATCH", body: JSON.stringify({ namedAgentId: id }),
    }), params);
    expect(response.status).toBe(200);
    const expected = id === "c" ? "claude-code" : "agy";
    expect((await response.json()).data).toMatchObject({ provider: expected, namedAgentId: id });
    sqlite.prepare("DELETE FROM named_agents WHERE id = ?").run(id);
    expect(sqlite.prepare("SELECT provider FROM chat_conversations WHERE id='chat'").get())
      .toEqual({ provider: expected });
  });
});
