/**
 * The property that makes a required `project`/`ref`/`heading` cheap (MCP-14): a wrong value is answered in
 * one call. These assert both halves of that - that the answer is there, and that it stays bounded, since an
 * unbounded one would cost more than the round-trip it saves.
 */
import { describe, expect, it } from "vitest";
import { nearMisses, suggest } from "./suggest";

const REFS = Array.from({ length: 40 }, (_, index) => `MCP-${index + 1}`);

describe("suggest", () => {
  it("lists every candidate when there are few enough to be worth the context", () => {
    expect(suggest("spansh", ["apm", "spanish", "plants"], "list_projects")).toBe(" Available: apm, spanish, plants.");
  });

  it("offers near misses instead of the whole list once it is long", () => {
    const hint = suggest("MCP-41", REFS, "list_items");
    expect(hint).toContain("Did you mean: MCP-4");
    expect(hint).toContain("40 in total");
    expect(hint).not.toContain("MCP-23"); // bounded: the backlog is not dumped into the reply
  });

  it("still says where to look when nothing is close", () => {
    expect(suggest("zzzzzz", REFS, "list_items")).toBe(" 40 exist - call list_items to see them.");
  });

  it("says nothing when there is nothing to suggest, leaving the caller to explain the empty case", () => {
    expect(suggest("apm", [], "list_projects")).toBe("");
  });
});

describe("nearMisses", () => {
  it("treats a partial handle as a match rather than a typo", () => {
    // The commonest miss: an area used where a ref belongs, or a remembered fragment of a heading.
    expect(nearMisses("MCP", ["DATA-1", "MCP-3", "MCP-4"])).toEqual(["MCP-3", "MCP-4"]);
    expect(nearMisses("storage", ["Goals", "The storage model"])).toEqual(["The storage model"]);
  });

  it("catches a one-character slip, and rejects an unrelated string", () => {
    expect(nearMisses("MCP-31", ["MCP-3", "MCP-13", "DATA-9"])).toEqual(["MCP-3", "MCP-13"]);
    expect(nearMisses("kitchen", ["MCP-3", "DATA-9"])).toEqual([]);
  });

  it("is case-insensitive, since the model is guessing a handle it half-remembers", () => {
    expect(nearMisses("mcp-3", ["MCP-3"])).toEqual(["MCP-3"]);
  });
});
