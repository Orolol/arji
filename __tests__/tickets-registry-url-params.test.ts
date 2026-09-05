/**
 * The registry's URL contract, without a DOM (epic 5sCe4w0bxRYl).
 *
 * `__tests__/tickets-registry-url-state.test.tsx` proves the screen round-trips
 * through the address bar; this file pins the grammar underneath it — which
 * parameter names are owned, what a default looks like (absent), and what a
 * stale or hand-edited link degrades to.
 */
import { describe, expect, it } from "vitest";

import {
  REGISTRY_URL_DEFAULTS,
  parseRegistryUrlState,
  registryUrlSearch,
  type RegistryUrlState,
} from "@/lib/tickets-registry/url-state";

function state(overrides: Partial<RegistryUrlState> = {}): RegistryUrlState {
  return { ...REGISTRY_URL_DEFAULTS, ...overrides };
}

describe("parseRegistryUrlState", () => {
  it("defaults an empty query string to the whole-workspace registry", () => {
    expect(parseRegistryUrlState("")).toEqual({
      projectId: null,
      status: "all",
      state: "all",
      sort: "activite",
      direction: "desc",
    });
  });

  it("reads every owned parameter", () => {
    expect(
      parseRegistryUrlState("?project=p2&status=review&state=done&sort=titre&direction=desc"),
    ).toEqual({
      projectId: "p2",
      status: "review",
      state: "done",
      sort: "titre",
      direction: "desc",
    });
  });

  it("accepts URLSearchParams as well as a raw string", () => {
    const params = new URLSearchParams("project=p1&sort=cout");
    expect(parseRegistryUrlState(params)).toEqual(parseRegistryUrlState("?project=p1&sort=cout"));
  });

  it("defaults the direction PER SORT, so a column starts the way it reads best", () => {
    // `titre` reads A→Z, `cout` reads most-expensive-first.
    expect(parseRegistryUrlState("?sort=titre").direction).toBe("asc");
    expect(parseRegistryUrlState("?sort=cout").direction).toBe("desc");
    expect(parseRegistryUrlState("?sort=titre&direction=desc").direction).toBe("desc");
  });

  it("falls back rather than throwing on a stale or hand-edited link", () => {
    expect(
      parseRegistryUrlState("?status=archived&state=nope&sort=nope&direction=sideways"),
    ).toEqual(state());
    expect(parseRegistryUrlState(null)).toEqual(state());
    expect(parseRegistryUrlState(undefined)).toEqual(state());
  });

  it("treats a blank or whitespace project as no scope at all", () => {
    expect(parseRegistryUrlState("?project=").projectId).toBeNull();
    expect(parseRegistryUrlState("?project=%20%20").projectId).toBeNull();
    expect(parseRegistryUrlState("?project=%20p1%20").projectId).toBe("p1");
  });
});

describe("registryUrlSearch", () => {
  it("writes nothing for an all-defaults registry", () => {
    expect(registryUrlSearch(state())).toBe("");
  });

  it("omits each filter that is at its default", () => {
    expect(registryUrlSearch(state({ projectId: "p1" }))).toBe("?project=p1");
    expect(registryUrlSearch(state({ state: "done" }))).toBe("?state=done");
    expect(registryUrlSearch(state({ status: "review" }))).toBe("?status=review");
    expect(registryUrlSearch(state({ sort: "titre", direction: "asc" }))).toBe("?sort=titre");
    expect(registryUrlSearch(state({ sort: "titre", direction: "desc" }))).toBe(
      "?sort=titre&direction=desc",
    );
    expect(registryUrlSearch(state({ direction: "asc" }))).toBe("?direction=asc");
  });

  it("keeps parameters it does not own, and drops its own stale ones", () => {
    expect(registryUrlSearch(state({ projectId: "p2" }), "?ticket=epic-1&project=p1")).toBe(
      "?ticket=epic-1&project=p2",
    );
    expect(registryUrlSearch(state(), "?ticket=epic-1&project=p1&sort=titre")).toBe(
      "?ticket=epic-1",
    );
  });

  it("round-trips every state it can write", () => {
    for (const value of [
      state({ projectId: "p1", status: "to_merge", sort: "stories", direction: "asc" }),
      state({ state: "your_turn", sort: "etat", direction: "desc" }),
      state({ projectId: "id with spaces & symbols=" }),
    ]) {
      expect(parseRegistryUrlState(registryUrlSearch(value))).toEqual(value);
    }
  });

  it("produces one string per state, so a no-op write can be detected", () => {
    const search = registryUrlSearch(state({ projectId: "p1", state: "done" }));
    expect(registryUrlSearch(parseRegistryUrlState(search), search)).toBe(search);
  });
});
