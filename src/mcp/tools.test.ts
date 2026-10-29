/**
 * The tool boundary's own contract (MCP-14): a required `project`, `ref` or `heading` that is wrong costs one
 * call, not two. The unit under test is therefore the *message*, which is why these assert on text rather than
 * only on `isError` - an error saying "call list_items to see them" would pass a looser assertion and still
 * be the bug.
 *
 * Handlers are captured through a stub `McpServer`: `registerTools` only ever calls `registerTool`, so a stub
 * that records the callbacks drives the real handlers with no transport, no stdio and no protocol framing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { freshDb } from "../db/testing";
import { comments } from "../db/schema";
import type { Database } from "../db/client";
import { createItem, listItems, setStatus } from "../domain/items";
import { FULL_BOARD_LIMIT } from "../domain/memory";
import type { OwnedProjectId } from "../domain/owned";
import { createProjectWithDefaults } from "../domain/projects";
import { PROTOCOL_HEADING, setSection } from "../domain/context";
import { addComment, SHORT_ID } from "../domain/comments";
import { INSTRUCTIONS, registerTools } from "./tools";

const ACTOR = "test";
type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function toolsOf(db: Database, ownerId: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const stub = {
    registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler),
  } as unknown as McpServer;
  registerTools(
    stub,
    db,
    { persist: async () => {}, refresh: async () => false, appendMeasurements: async () => {} },
    { open: async (key: string) => `http://127.0.0.1:5177/#${key}`, close: async () => {} },
    { ownerId },
  );
  return handlers;
}

/** The reply's text, whether it came back as a result or an error. Narrowed rather than cast: `content` is a
 *  union of block kinds and every tool here returns the text one. */
const said = (result: CallToolResult): string => {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
};

describe("not-found errors answer the question", () => {
  let tools: Map<string, Handler>;

  beforeAll(async () => {
    const { db, ownerId } = await freshDb();
    const apm = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await createProjectWithDefaults(db, { key: "spanish", name: "Spanish", type: "learning", ownerId }, ACTOR);
    await createItem(db, { projectId: apm.id, area: "MCP", title: "the stdio server" }, ACTOR);
    await createItem(db, { projectId: apm.id, area: "DATA", title: "storage" }, ACTOR);
    await setSection(db, { projectId: apm.id, heading: "The storage model", content: "PGlite" }, ACTOR);
    tools = toolsOf(db, ownerId);
  });

  it("names the project keys, so a wrong one does not cost a round-trip through list_projects", async () => {
    const result = await tools.get("get_project")!({ project: "amp" });
    expect(result.isError).toBe(true);
    expect(said(result)).toBe('no project with key "amp". Available: apm, spanish.');
  });

  it("names the refs on a mutation, not just on a read", async () => {
    // set_status and edit_item reach a domain guard that can only say the ref is unknown; the tool layer
    // resolves first so the reply can say what it might have been instead.
    const result = await tools.get("set_status")!({ project: "apm", ref: "MCP-9", status: "done" });
    expect(result.isError).toBe(true);
    expect(said(result)).toBe('no item "MCP-9" in apm. Available: DATA-1, MCP-1.');

    const edited = await tools.get("edit_item")!({ project: "apm", ref: "MCP-9", title: "x" });
    expect(said(edited)).toContain("Available: DATA-1, MCP-1");
  });

  it("names the refs on a read too, and on a comment filed against one", async () => {
    expect(said(await tools.get("get_item")!({ project: "apm", ref: "MCP-9" }))).toContain("Available: DATA-1, MCP-1");
    expect(said(await tools.get("add_comment")!({ project: "apm", comment: "hm", ref: "MCP-9" }))).toContain("Available:");
  });

  it("names the context headings, which are free text and the easiest thing to half-remember", async () => {
    const result = await tools.get("get_context")!({ project: "apm", heading: "storage" });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain('no context section "storage" in apm');
    expect(said(result)).toContain("The storage model");
  });

  it("still succeeds on the happy path", async () => {
    expect(said(await tools.get("get_item")!({ project: "apm", ref: "MCP-1" }))).toContain("the stdio server");
    expect((await tools.get("set_status")!({ project: "apm", ref: "MCP-1", status: "done" })).isError).toBeUndefined();
  });
});

describe("the graph tools (MCP-16 to MCP-19)", () => {
  let tools: Map<string, Handler>;
  let db: Database;
  let ownerId: string;

  beforeAll(async () => {
    ({ db, ownerId } = await freshDb());
    const apm = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: apm.id, area: "MCP", title: "the stdio server" }, ACTOR);
    await createItem(db, { projectId: apm.id, area: "MCP", title: "the tools" }, ACTOR);
    tools = toolsOf(db, ownerId);
  });

  it("sets dependencies from create and edit, and echoes them back so the caller can see what stuck", async () => {
    const created = await tools.get("create_item")!({ project: "apm", area: "MCP", title: "third", deps: ["MCP-1"] });
    expect(said(created)).toContain("depends on: MCP-1");
    const edited = await tools.get("edit_item")!({ project: "apm", ref: "MCP-3", deps: ["MCP-1", "MCP-2"] });
    expect(said(edited)).toContain("depends on: MCP-1, MCP-2");
    expect(said(await tools.get("get_item")!({ project: "apm", ref: "MCP-3" }))).toContain("depends on: MCP-1, MCP-2");
  });

  it("gives a bad dep ref the same near-miss treatment as a bad item ref", async () => {
    // The domain can only say the ref is unknown; the tool resolves first so the reply can say what it meant.
    const result = await tools.get("edit_item")!({ project: "apm", ref: "MCP-1", deps: ["MCP-9"] });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain("Available: MCP-1, MCP-2, MCP-3");
  });

  it("lets a dependency name another project, even one this store has never heard of (PROJ-11)", async () => {
    // The tool layer resolves each ref first so it can name the near misses, and that pre-check used to
    // reject every scoped ref before the domain ever saw it - suggesting `list_items` for a ref that is
    // deliberately not in this project. It cost nine real edges when the plan was split.
    const edited = await tools.get("edit_item")!({ project: "apm", ref: "MCP-3", deps: ["MCP-1", "apm-cloud:OPS-4"] });
    expect(edited.isError).toBeFalsy();
    expect(said(edited)).toContain("depends on: MCP-1, apm-cloud:OPS-4");
    expect(said(await tools.get("get_item")!({ project: "apm", ref: "MCP-3" }))).toContain("apm-cloud:OPS-4");
  });

  it("still gives a bad local ref the near-miss treatment when a scoped one sits beside it", async () => {
    const result = await tools.get("edit_item")!({ project: "apm", ref: "MCP-3", deps: ["apm-cloud:OPS-4", "MCP-9"] });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain("Available: MCP-1, MCP-2, MCP-3");
  });

  it("says clearing the deps happened, rather than replying as if nothing changed", async () => {
    expect(said(await tools.get("edit_item")!({ project: "apm", ref: "MCP-3", deps: [] }))).toContain("depends on: (nothing)");
  });

  it("creates a sub-item under a parent and takes an explicit ref", async () => {
    expect(said(await tools.get("create_item")!({ project: "apm", parent: "MCP-1", title: "sub" }))).toContain("MCP-1.1");
    expect(said(await tools.get("create_item")!({ project: "apm", ref: "DATA-7", title: "imported" }))).toContain("DATA-7");
  });

  it("deletes softly, and says so - the point of the tool is that experimenting is safe", async () => {
    const result = await tools.get("delete_item")!({ project: "apm", ref: "DATA-7" });
    expect(said(result)).toContain("deleted DATA-7");
    expect(said(result)).toContain("event log");
    expect(said(await tools.get("list_items")!({ project: "apm" }))).not.toContain("DATA-7");
    // still readable, and legibly deleted rather than looking live
    expect(said(await tools.get("get_item")!({ project: "apm", ref: "DATA-7" }))).toContain("deleted at");
  });

  it("refuses to delete a item that still frames sub-items", async () => {
    const result = await tools.get("delete_item")!({ project: "apm", ref: "MCP-1" });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain("MCP-1.1");
  });
});

describe("open_viewer", () => {
  let tools: Map<string, Handler>;

  beforeAll(async () => {
    const { db, ownerId } = await freshDb();
    await createProjectWithDefaults(db, { key: "spanish", name: "Spanish", type: "learning", ownerId }, ACTOR);
    tools = toolsOf(db, ownerId);
  });

  it("returns a URL that lands on the project asked for (VIEW-4)", async () => {
    const result = await tools.get("open_viewer")!({ project: "spanish" });
    expect(said(result)).toContain("http://127.0.0.1:5177/#spanish");
  });

  it("fails at the tool rather than handing back a link to an error page", async () => {
    const result = await tools.get("open_viewer")!({ project: "german" });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain("Available: spanish");
    expect(said(result)).not.toContain("http://"); // no URL to click, since there is nothing there to see
  });
});

describe("replies that state derived state (MCP-20, MCP-21, CTX-11)", () => {
  let tools: Map<string, Handler>;

  beforeAll(async () => {
    const { db, ownerId } = await freshDb();
    const apm = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: apm.id, area: "MCP", title: "one" }, ACTOR);
    await createItem(db, { projectId: apm.id, area: "MCP", title: "two", status: "done" }, ACTOR);
    await createItem(db, { projectId: apm.id, area: "DATA", title: "three" }, ACTOR);
    await setSection(db, { projectId: apm.id, heading: "Thesis", content: "t" }, ACTOR);
    await setSection(db, { projectId: apm.id, heading: "Licensing", content: "l" }, ACTOR);
    tools = toolsOf(db, ownerId);
  });

  it("leads a listing with a count, so a stale one carried in a comment is contradicted", async () => {
    expect(said(await tools.get("list_items")!({ project: "apm" }))).toMatch(/^3 items in apm\n/);
  });

  it("says what was filtered and what the whole is, since only the pair is safe to write down", async () => {
    const filtered = said(await tools.get("list_items")!({ project: "apm", status: "done" }));
    expect(filtered).toMatch(/^1 done item of 3 in apm\n/); // singular, and the unfiltered total rides along
    expect(said(await tools.get("list_items")!({ project: "apm", area: "NOPE" }))).toBe("0 NOPE items of 3 in apm - nothing matches");
  });

  it("stamps the build on the two replies that are otherwise identical whether it is current or an hour stale", async () => {
    for (const tool of ["get_project", "open_viewer"]) {
      const reply = said(await tools.get(tool)!({ project: "apm" }));
      expect(reply).toContain("server started");
      expect(reply).toMatch(/up \d|just started/);
      expect(reply).toContain("reconnect before trusting this");
    }
  });

  it("places a context section and echoes the resulting order back", async () => {
    const reply = said(await tools.get("set_context")!({ project: "apm", heading: "Goal", content: "g", after: "" }));
    // The order is derived state that this call changed, so the reply states it rather than only confirming.
    expect(reply).toContain("order: Goal -> protocol -> Thesis -> Licensing");
    const moved = said(await tools.get("set_context")!({ project: "apm", heading: "Licensing", content: "l", after: "Thesis" }));
    expect(moved).toContain("order: Goal -> protocol -> Thesis -> Licensing");
  });

  it("refuses an anchor that does not exist rather than quietly appending", async () => {
    const result = await tools.get("set_context")!({ project: "apm", heading: "New", content: "n", after: "Nope" });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain('no context section "Nope"');
  });
});

describe("a refused save is a failed tool call (IMP-13)", () => {
  it("reports an error rather than success when the store could not be written", async () => {
    // The property the bug report asked for, and the one that makes the IMP-13 guard useful at all: if
    // persistence refuses, the caller must be told. A success here would leave an agent believing in a item
    // that exists only in this process's memory - which is exactly what the incident looked like from inside.
    const { db, ownerId } = await freshDb();
    await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const handlers = new Map<string, Handler>();
    const stub = {
      registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler),
    } as unknown as McpServer;
    registerTools(
      stub,
      db,
      {
        persist: async () => {
          throw new Error("refusing to save: the file has changed since this server loaded it");
        },
        refresh: async () => false,
        appendMeasurements: async () => {},
      },
      { open: async (key: string) => `http://127.0.0.1:5177/#${key}`, close: async () => {} },
      { ownerId },
    );

    const result = await handlers.get("create_item")!({ project: "apm", area: "MCP", title: "lost otherwise" });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain("refusing to save");
  });
});

describe("every tool picks up an external change first (IMP-10)", () => {
  /** Register the real tools against a store whose refresh is counted, and optionally reports a reload. */
  function counted(db: Database, ownerId: string, reloaded: boolean) {
    const handlers = new Map<string, Handler>();
    const stub = {
      registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler),
    } as unknown as McpServer;
    let refreshes = 0;
    registerTools(
      stub,
      db,
      {
        persist: async () => {},
        refresh: async () => {
          refreshes++;
          return reloaded;
        },
        appendMeasurements: async () => {},
      },
      { open: async (key: string) => `http://127.0.0.1:5177/#${key}`, close: async () => {} },
      { ownerId },
    );
    return { handlers, count: () => refreshes };
  }

  it("refreshes on every tool, including the ones that only read", async () => {
    // The guarantee is structural rather than per-tool: a handler that skipped the refresh would answer
    // confidently from a plan that no longer exists, and nothing in its reply would look wrong. So the
    // assertion is over *all* registered tools, and a tool added later that bypasses the wrapper fails here.
    //
    // Called with no arguments deliberately: the refresh must happen before the handler looks at anything, so
    // even a call that goes on to fail validation must have refreshed by then.
    const { db, ownerId } = await freshDb();
    const { handlers, count } = counted(db, ownerId, false);
    expect(handlers.size).toBeGreaterThan(15); // a sanity check that this is really covering the tool surface

    let expected = 0;
    for (const [name, handler] of handlers) {
      await handler({});
      expected++;
      expect(count(), `${name} did not refresh`).toBe(expected);
    }
  });

  it("says so in the reply when the plan was reloaded, on success and on failure alike", async () => {
    // A silent reload leaves the session holding refs and counts from the previous plan with nothing to
    // contradict them - the MCP-21 rule, applied to the largest piece of derived state there is.
    const { db, ownerId } = await freshDb();
    await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const { handlers } = counted(db, ownerId, true);

    const ok = await handlers.get("list_items")!({ project: "apm" });
    expect(ok.isError).toBeUndefined();
    expect(said(ok)).toContain("changed on disk and was reloaded");

    const failed = await handlers.get("list_items")!({ project: "nope" });
    expect(failed.isError).toBe(true);
    expect(said(failed)).toContain("changed on disk and was reloaded");
  });
});

/**
 * `search_plan` (MCP-24). The domain query is covered in `search.test.ts`; what is tested here is the reply,
 * because the reply is the whole product for this tool: a snippet without a ref is unopenable, and a miss that
 * reads as an error teaches the model not to search again.
 */
describe("search_plan (MCP-24)", () => {
  let tools: Map<string, Handler>;

  beforeAll(async () => {
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const item = await createItem(
      db,
      { projectId: project.id, area: "VIEW", title: "Move the host onto Hono when it goes remote", body: "Should the viewer host use a backend framework rather than raw node:http? Express installs thirty packages, and this server lives inside a stdio process." },
      ACTOR,
    );
    await addComment(db, { projectId: project.id, itemId: item.id, body: "Decided against Express on the strength of the stdout audit.", audience: "agent" }, ACTOR);
    await setSection(db, { projectId: project.id, heading: "The storage model", content: "PGlite is rebuilt from the YAML on every load." }, ACTOR);
    tools = toolsOf(db, ownerId);
  });

  it("leads each hit with the address that opens it", async () => {
    const reply = said(await tools.get("search_plan")!({ project: "apm", query: "backend framework" }));
    expect(reply).toContain("VIEW-1 [item] Move the host onto Hono when it goes remote");
    // The matched terms are marked, and the body is *quoted* rather than reproduced: `ts_headline` returns a
    // window around the match, so the tail of this body is absent. That is the budget argument in miniature -
    // a hit that is not opened should cost a line, not a document.
    expect(reply).toContain("**backend** **framework**");
    expect(reply).not.toContain("stdio process");
  });

  it("marks an agent comment as one, and hangs it off its item", async () => {
    const reply = said(await tools.get("search_plan")!({ project: "apm", query: "stdout audit" }));
    expect(reply).toMatch(/VIEW-1 \[comment \w+\] \(agent\)/);
    expect(reply).toContain("**stdout** **audit**");
  });

  it("finds a context section by its prose, not only its heading", async () => {
    const reply = said(await tools.get("search_plan")!({ project: "apm", query: "rebuilt from the YAML" }));
    expect(reply).toContain("[context] The storage model");
  });

  it("answers a miss as an answer, not an error", async () => {
    const result = await tools.get("search_plan")!({ project: "apm", query: "kubernetes helm chart" });
    // Not `isError`: "nothing is recorded about this" is exactly what the caller wanted to know, and a tool
    // that reports a miss as a failure teaches the model to stop searching speculatively - which is the
    // behaviour this whole item exists to produce.
    expect(result.isError).toBeFalsy();
    expect(said(result)).toContain("no matches");
  });

  it("still refuses a project the caller does not own", async () => {
    const result = await tools.get("search_plan")!({ project: "not-mine", query: "anything" });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain('no project with key "not-mine"');
  });
});

/**
 * `list_items` as records (`MCP-26`). The board is the case the artifact report was really about, and the
 * structured form is `RoadmapItem` from the shared model rather than a shape invented for this tool.
 */
describe("list_items returns the board as records (MCP-26)", () => {
  it("returns the shared item model, with edges and nesting", async () => {
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const base = await createItem(db, { projectId: project.id, area: "DATA", title: "Search index", body: "prose" }, ACTOR);
    await createItem(db, { projectId: project.id, parent: base.ref, title: "Sub", body: "prose" }, ACTOR);
    await createItem(db, { projectId: project.id, area: "MCP", title: "Search tool", body: "prose", deps: [base.ref] }, ACTOR);
    const tools = toolsOf(db, ownerId);

    const result = await tools.get("list_items")!({ project: "apm" });
    const items = (result.structuredContent as { items: Record<string, unknown>[] }).items;

    expect(items.map((t) => t.id)).toEqual(["DATA-1", "DATA-1.1", "MCP-1"]);
    // Edges, which is the one field a consumer cannot derive from a ref.
    expect(items.find((t) => t.id === "MCP-1")?.deps).toEqual(["DATA-1"]);
    // Nesting, which it can - but should not have to re-implement.
    expect(items.find((t) => t.id === "DATA-1.1")?.parent).toBe("DATA-1");
    expect(items.find((t) => t.id === "DATA-1")?.parent).toBeNull();
    // Metadata only: the board never wants the prose, which is what get_item is for.
    expect(JSON.stringify(items)).not.toContain("prose");
  });

  it("does not fetch bodies it will never render", async () => {
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: project.id, area: "DATA", title: "Search index", body: "SENTINEL body prose" }, ACTOR);

    // The listing is an index. A body is the expensive column - 257kB across this project's own items - and
    // no caller of listItems has ever read one, so it is not selected. Asserted on the domain call rather than
    // through the tool, because the tool could hide an over-fetch by simply not printing it.
    const rows = await listItems(db, { projectId: project.id });
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!)).not.toContain("body");
    expect(JSON.stringify(rows)).not.toContain("SENTINEL");
  });

  it("still says how many there are in total when a filter narrowed the list", async () => {
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: project.id, area: "DATA", title: "One" }, ACTOR);
    await createItem(db, { projectId: project.id, area: "MCP", title: "Two" }, ACTOR);
    const tools = toolsOf(db, ownerId);

    const result = await tools.get("list_items")!({ project: "apm", area: "DATA" });
    const structured = result.structuredContent as { total: number; items: unknown[] };
    // "1 item" and "1 of 2" are different facts and only the second is safe to write down (MCP-21).
    expect(structured.items).toHaveLength(1);
    expect(structured.total).toBe(2);
  });
});

/** `get_item` deliberately has no output schema: it returns a document, not a record (MCP-26). */
describe("get_item stays prose (MCP-26)", () => {
  it("returns the formatted item and no structured content", async () => {
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: project.id, area: "DATA", title: "Search index", body: "Full-text search over item bodies." }, ACTOR);
    const tools = toolsOf(db, ownerId);

    const result = await tools.get("get_item")!({ project: "apm", ref: "DATA-1" });
    expect(result.structuredContent).toBeUndefined();
    expect(said(result)).toContain("Full-text search over item bodies.");
  });
});

/**
 * `list_comments` as records (`MCP-26`, agreed 2026-09-01). A list of records is the case a schema is right
 * for - and this is the one reply where the short id is *addressable* rather than merely printed, so without
 * a schema a program wanting to edit a comment has to pull the id out of prose.
 */
describe("list_comments returns records (MCP-26)", () => {
  it("returns the short id, item ref and audience, with no prose in the payload", async () => {
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const item = await createItem(db, { projectId: project.id, area: "DATA", title: "Search index" }, ACTOR);
    // Inserted directly, because `addComment` refuses a project-level comment since `CTX-15`. Keeping one
    // here is the point: the reader must still render a legacy row, with a null ref, rather than choking.
    await db.insert(comments).values({ projectId: project.id, itemId: null, body: "loose one", audience: "user", actor: ACTOR });
    await addComment(db, { projectId: project.id, body: "on the item", itemId: item.id, audience: "agent" }, ACTOR);
    const tools = toolsOf(db, ownerId);

    const result = await tools.get("list_comments")!({ project: "apm" });
    const rows = (result.structuredContent as { comments: Record<string, unknown>[] }).comments;

    expect(rows.map((c) => c.body)).toEqual(["on the item", "loose one"]); // newest first
    expect(rows[0]!.ref).toBe("DATA-1");
    expect(rows[0]!.audience).toBe("agent");
    expect(rows[1]!.ref).toBeNull(); // a legacy project-level comment hangs off nothing, and still reads
    // The id is the short form, matching what the text prints and what edit_comment takes. Two id shapes in
    // one reply would be a trap for whoever passes the wrong one back.
    expect(rows[0]!.id).toHaveLength(SHORT_ID);
    expect(said(result)).toContain(rows[0]!.id);
  });

  it("still returns an empty array when there are none, rather than omitting the field", async () => {
    // The SDK throws if a tool declares an output schema and returns nothing structured, so the empty case
    // has to carry the shape too - and a consumer reading `.comments.length` should not have to guard.
    const { db, ownerId } = await freshDb();
    await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const tools = toolsOf(db, ownerId);

    const result = await tools.get("list_comments")!({ project: "apm" });
    expect((result.structuredContent as { comments: unknown[] }).comments).toEqual([]);
  });
});

/**
 * `get_project` as a composition (`CTX-4`): the protocol section plus `list_items` plus `list_context` plus
 * the project header. The thing worth testing is that it renders them the *same way* those tools do - two
 * renderings of one row is how they drift apart.
 */
describe("get_project is an index, not the plan (CTX-4)", () => {
  it("renders each part with the formatter its own tool uses", async () => {
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await setSection(db, { projectId: project.id, heading: "The storage model", content: "PGlite, rebuilt from YAML" }, ACTOR);
    await createItem(db, { projectId: project.id, area: "DATA", title: "Search index", body: "prose nobody wants in the pack" }, ACTOR);
    const tools = toolsOf(db, ownerId);

    const pack = said(await tools.get("get_project")!({ project: "apm" }));

    // Items exactly as list_items renders them, headings exactly as list_context does.
    expect(pack).toContain(said(await tools.get("list_items")!({ project: "apm" })).split("\n").slice(1).join("\n"));
    // list_context lists every heading; the pack's table of contents omits `protocol`, which it already
    // carried in full. Same formatter, one deliberate subtraction.
    const headings = said(await tools.get("list_context")!({ project: "apm" }))
      .split("\n")
      .filter((line) => line !== `- ${PROTOCOL_HEADING}`)
      .join("\n");
    expect(pack).toContain(headings);
    // The protocol in full, because CTX-9 makes it read-every-session. Read through get_context, which is
    // now the only tool for it: get_protocol was sugar over exactly this call and was removed with the rename.
    expect(pack).toContain(said(await tools.get("get_context")!({ project: "apm", heading: PROTOCOL_HEADING })).slice(6, 80));
    // ...while every other section is named and not carried, and no item body rides along.
    expect(pack).toContain("The storage model");
    expect(pack).not.toContain("PGlite, rebuilt from YAML");
    expect(pack).not.toContain("prose nobody wants in the pack");
  });

  it("says what it is holding back and which tool reaches it", async () => {
    // The one genuinely new thing the composition has to add. Holding back this much silently is the failure
    // MCP-24 was filed about, so the counts and the tool names are the feature, not a courtesy.
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await setSection(db, { projectId: project.id, heading: "Licensing", content: "the open-core line" }, ACTOR);
    const held = await createItem(db, { projectId: project.id, area: "MCP", title: "server" }, ACTOR);
    await addComment(db, { projectId: project.id, itemId: held.id, body: "zzz-first-comment" }, ACTOR);
    await addComment(db, { projectId: project.id, itemId: held.id, body: "zzz-second-comment" }, ACTOR);
    const tools = toolsOf(db, ownerId);

    const pack = said(await tools.get("get_project")!({ project: "apm" }));
    expect(pack).toContain("2 comments");
    expect(pack).toContain("list_comments");
    expect(pack).toContain("get_context");
    expect(pack).toContain("search_plan");
    expect(pack).not.toContain("zzz-"); // the comments themselves are gone, not merely shortened
  });

  it("stays singular and drops the lines it has nothing to report", async () => {
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const only = await createItem(db, { projectId: project.id, area: "MCP", title: "server" }, ACTOR);
    await addComment(db, { projectId: project.id, itemId: only.id, body: "the only comment" }, ACTOR);
    const tools = toolsOf(db, ownerId);

    // Asserted on the held block alone: the seeded protocol text itself talks about context sections, so a
    // whole-pack substring check would match the wrong thing.
    const held = said(await tools.get("get_project")!({ project: "apm" })).split("\n---\n")[1]!;
    expect(held).toContain("1 comment -"); // not "1 comments"
    // A fresh project has only the seeded protocol, so there is no table of contents to advertise.
    expect(held).not.toContain("context section");
  });
});

/**
 * The agreed order in the pack (`PROJ-8`). The item listing was 78% of a 13.8kB pack and the only part that
 * grows without bound, so `next` does not sit beside it - it replaces it once the board stops being small.
 */
describe("set_next and the trimmed board (PROJ-8)", () => {
  const seedBoard = async (db: Awaited<ReturnType<typeof freshDb>>["db"], projectId: OwnedProjectId, n: number) => {
    for (let i = 0; i < n; i++) await createItem(db, { projectId, area: "MCP", title: `title ${i}` }, ACTOR);
  };

  it("numbers the order and reports a blocker rather than refusing it", async () => {
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: project.id, area: "DATA", title: "schema" }, ACTOR);
    await createItem(db, { projectId: project.id, area: "MCP", title: "server", deps: ["DATA-1"] }, ACTOR);
    const tools = toolsOf(db, ownerId);

    const reply = said(await tools.get("set_next")!({ project: "apm", refs: ["MCP-1", "DATA-1"] }));
    expect(reply).toContain("1. MCP-1 [to-do] server (blocked by DATA-1 [to-do])");
    expect(reply).toContain("2. DATA-1 [to-do] schema");

    expect(said(await tools.get("set_next")!({ project: "apm", refs: [] }))).toBe("next: cleared");
  });

  it("says when a ref was stored but will not be shown", async () => {
    // Written and shown can differ, and letting that pass silently looks like the write dropped it.
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: project.id, area: "MCP", title: "server" }, ACTOR);
    await createItem(db, { projectId: project.id, area: "DATA", title: "schema", status: "done" }, ACTOR);
    const tools = toolsOf(db, ownerId);

    const reply = said(await tools.get("set_next")!({ project: "apm", refs: ["MCP-1", "DATA-1"] }));
    expect(reply).toContain("1 ref stored but not shown"); // not "1 refs"
    expect(reply).not.toContain("DATA-1");
  });

  it("replaces the open listing with two headed groups and a count, once the board is big", async () => {
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await seedBoard(db, project.id, FULL_BOARD_LIMIT + 1);
    await setStatus(db, { projectId: project.id, ref: "MCP-1", status: "in-progress" }, ACTOR);
    const tools = toolsOf(db, ownerId);
    await tools.get("set_next")!({ project: "apm", refs: ["MCP-5"] });

    const pack = said(await tools.get("get_project")!({ project: "apm" }));
    expect(pack).toContain("## In progress (1)\nMCP-1 [in-progress] title 0");
    expect(pack).toContain("## Next (1)\nMCP-5 [to-do] title 4");
    expect(pack).not.toContain("## Open items");
    // "More open items", never "items": the groups above are a partial view of the same set, so a count that
    // silently overlapped them would get misread once and then distrusted.
    expect(pack).toContain(`- ${FULL_BOARD_LIMIT - 1} more open items (${FULL_BOARD_LIMIT - 1} to-do) - list_items`);
    expect(pack).not.toContain("title 9]"); // the rest of the board is genuinely gone, not merely reordered
  });

  it("says no order was recorded rather than printing a heading over nothing", async () => {
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await seedBoard(db, project.id, FULL_BOARD_LIMIT + 1);
    const tools = toolsOf(db, ownerId);

    const pack = said(await tools.get("get_project")!({ project: "apm" }));
    expect(pack).toContain("no order recorded - set one with set_next");
    expect(pack).toContain(`- ${FULL_BOARD_LIMIT + 1} more open items`);
  });

  it("names the areas once the listing that used to reveal them is gone, and only then", async () => {
    // The trim removed the thing that conveyed the area vocabulary by accident: 126 titles showed every
    // prefix. With the listing replaced, nothing else says that an area exists.
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await seedBoard(db, project.id, FULL_BOARD_LIMIT + 1);
    await createItem(db, { projectId: project.id, area: "VIEW", title: "the viewer" }, ACTOR);
    const tools = toolsOf(db, ownerId);

    const pack = said(await tools.get("get_project")!({ project: "apm" }));
    // Rendered by list_areas' own formatter, so the pack cannot become a second rendering of the same rows.
    expect(pack).toContain(said(await tools.get("list_areas")!({ project: "apm" })));
    expect(pack).toContain("## Areas");
    expect(pack).toContain("by area or status"); // the held line names both filters list_items takes
  });

  it("still carries the whole board while it is small, exactly as list_items renders it", async () => {
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await seedBoard(db, project.id, 3);
    const tools = toolsOf(db, ownerId);

    const pack = said(await tools.get("get_project")!({ project: "apm" }));
    expect(pack).toContain("## Open items");
    expect(pack).not.toContain("more open items");
    // No area block while every title is shown: the titles already carry the prefixes, so it would be a
    // second copy of what is directly above it.
    expect(pack).not.toContain("## Areas");
  });
});

/**
 * The measurement tools (`METRIC-2`). The tool layer is where `METRIC-1`'s one behavioural requirement lands:
 * writing a tree has to cost no more than writing a flat list, or nobody writes a tree.
 */
describe("measurement tools (METRIC-2)", () => {
  const appended: unknown[] = [];
  const toolsWithFiles = (db: Awaited<ReturnType<typeof freshDb>>["db"], ownerId: string) => {
    appended.length = 0;
    const handlers = new Map<string, Handler>();
    const stub = { registerTool: (name: string, _c: unknown, handler: Handler) => handlers.set(name, handler) } as unknown as McpServer;
    registerTools(
      stub,
      db,
      {
        // Fails loudly if a write ever tries to persist the plan for a measurement: these rows are kept out
        // of it on purpose, and re-serialising it to record one number is the cost the split avoids.
        persist: async () => {
          throw new Error("the plan must not be rewritten to record a measurement");
        },
        refresh: async () => false,
        appendMeasurements: async (records) => {
          appended.push(...records);
        },
      },
      { open: async (key: string) => `http://127.0.0.1:5177/#${key}`, close: async () => {} },
      { ownerId },
    );
    return handlers;
  };

  it("records a group and its readings in one call, and appends them to the files", async () => {
    const { db, ownerId } = await freshDb();
    await createProjectWithDefaults(db, { key: "health", name: "Health", type: "health", ownerId }, ACTOR);
    const tools = toolsWithFiles(db, ownerId);

    const reply = said(
      await tools.get("record_measurements")!({
        project: "health",
        at: "2026-08-14T08:00:00.000Z",
        group: { metric: "meal", label: "overnight oats" },
        readings: [
          { metric: "kcal", value: 420 },
          { metric: "protein_g", value: 24, unit: "g" },
        ],
      }),
    );

    // The reply shows the shape, indented, because it is the only place an agent sees what it just built.
    expect(reply).toContain("meal: - (overnight oats)");
    expect(reply).toContain("  kcal: 420");
    expect(reply).toContain("  protein_g: 24 g");
    // Appended, never persisted - the stubbed `persist` throws, so a plan rewrite would have failed this.
    expect(appended).toHaveLength(3);
  });

  it("refuses a reading that is both a number and text, and one that is neither", async () => {
    const { db, ownerId } = await freshDb();
    await createProjectWithDefaults(db, { key: "health", name: "Health", type: "health", ownerId }, ACTOR);
    const tools = toolsWithFiles(db, ownerId);

    expect(said(await tools.get("record_measurements")!({ project: "health", readings: [{ metric: "sleep", value: 7, text: "restless" }] }))).toContain("one or the other");
    expect(said(await tools.get("record_measurements")!({ project: "health", readings: [{ metric: "sleep" }] }))).toContain("no reading");
    expect(appended).toHaveLength(0);
  });

  it("lists the vocabulary, because it is discovered rather than declared", async () => {
    const { db, ownerId } = await freshDb();
    await createProjectWithDefaults(db, { key: "health", name: "Health", type: "health", ownerId }, ACTOR);
    const tools = toolsWithFiles(db, ownerId);
    await tools.get("record_measurements")!({ project: "health", readings: [{ metric: "body_weight", value: 78.4, unit: "kg" }] });

    const result = await tools.get("list_metrics")!({ project: "health" });
    expect((result.structuredContent as { metrics: unknown[] }).metrics).toEqual([{ metric: "body_weight", count: 1, units: ["kg"] }]);
  });

  it("warns when a window mixes units, because those numbers are not comparable", async () => {
    const { db, ownerId } = await freshDb();
    await createProjectWithDefaults(db, { key: "health", name: "Health", type: "health", ownerId }, ACTOR);
    const tools = toolsWithFiles(db, ownerId);
    await tools.get("record_measurements")!({ project: "health", at: "2026-08-14T07:00:00.000Z", readings: [{ metric: "body_weight", value: 78.4, unit: "kg" }] });
    await tools.get("record_measurements")!({ project: "health", at: "2026-08-15T07:00:00.000Z", readings: [{ metric: "body_weight", value: 172, unit: "lb" }] });

    // A kg/lb series is a 2.2x step change that plots as a dramatic gain, so the query says so rather than
    // leaving it for whoever draws the chart to notice.
    const reply = said(await tools.get("query_measurements")!({ project: "health", metric: "body_weight", aggregate: "avg" }));
    expect(reply).toContain("WARNING: this window mixes kg and lb");
    expect(reply).toContain("2026-08-14");

    // Three is not far-fetched - kg, lb and stone all measure the same thing, so switching apps produces it -
    // and `join(" and ")` would have read as a run-on.
    await tools.get("record_measurements")!({ project: "health", at: "2026-08-16T07:00:00.000Z", readings: [{ metric: "body_weight", value: 12.3, unit: "stone" }] });
    expect(said(await tools.get("query_measurements")!({ project: "health", metric: "body_weight" }))).toContain("mixes kg, lb and stone");
  });

  it("says when a numeric aggregate was asked of a categorical metric", async () => {
    const { db, ownerId } = await freshDb();
    await createProjectWithDefaults(db, { key: "health", name: "Health", type: "health", ownerId }, ACTOR);
    const tools = toolsWithFiles(db, ownerId);
    await tools.get("record_measurements")!({ project: "health", at: "2026-08-14T07:00:00.000Z", readings: [{ metric: "sleep_quality", text: "restless" }] });

    // Without this the reply is a blank column, which reads as "nothing recorded" rather than "wrong question".
    const summed = said(await tools.get("query_measurements")!({ project: "health", metric: "sleep_quality" }));
    expect(summed).toContain("no numeric readings");
    expect(summed).toContain('aggregate "count"');

    // And counting it says nothing, because counting is the right question.
    expect(said(await tools.get("query_measurements")!({ project: "health", metric: "sleep_quality", aggregate: "count" }))).not.toContain("no numeric readings");
  });

  it("takes `project` as the ref that means the project itself", async () => {
    const { db, ownerId } = await freshDb();
    const p = await createProjectWithDefaults(db, { key: "health", name: "Health", type: "health", ownerId }, ACTOR);
    await createItem(db, { projectId: p.id, area: "LIFT", title: "Bench press" }, ACTOR);
    const tools = toolsWithFiles(db, ownerId);
    await tools.get("record_measurements")!({ project: "health", ref: "LIFT-1", at: "2026-08-14T07:00:00.000Z", readings: [{ metric: "reps", value: 8 }] });
    await tools.get("record_measurements")!({ project: "health", at: "2026-08-14T07:00:00.000Z", readings: [{ metric: "reps", value: 99 }] });

    expect(said(await tools.get("query_measurements")!({ project: "health", metric: "reps" }))).toContain("107");
    expect(said(await tools.get("query_measurements")!({ project: "health", metric: "reps", ref: "project" }))).toContain("99");
    expect(said(await tools.get("query_measurements")!({ project: "health", metric: "reps", ref: "LIFT-1" }))).toContain("8");
  });
});

/** `list_areas` (PROJ-8 follow-on): the map you pick an area from before calling `list_items(area:)`. */
describe("list_areas returns records", () => {
  it("returns every prefix in use, named or not, with open and total counts", async () => {
    const { db, ownerId } = await freshDb();
    const project = await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: project.id, area: "MCP", title: "server" }, ACTOR);
    await createItem(db, { projectId: project.id, area: "MCP", title: "tools", status: "done" }, ACTOR);
    const tools = toolsOf(db, ownerId);

    const result = await tools.get("list_areas")!({ project: "apm" });
    // `name` is null rather than the key repeated back: an area nobody has named should read as unnamed, not
    // as one whose name happens to be its prefix.
    expect((result.structuredContent as { areas: unknown[] }).areas).toEqual([{ key: "MCP", name: null, open: 1, total: 2 }]);
    expect(said(result)).toContain("MCP    1 open of 2");  // padded into a column, since this is scanned
  });
});

/** `list_projects` as records (MCP-26): the picker that pairs with structured `list_items`. */
describe("list_projects returns records (MCP-26)", () => {
  it("returns key, name, type and direction, unambiguously", async () => {
    const { db, ownerId } = await freshDb();
    // A name carrying the text form's own delimiters, which is exactly why the schema is here: the prose
    // renders this as "spanish - Spanish - B2 (learning)" and nothing says which " - " is structural.
    await createProjectWithDefaults(db, { key: "spanish", name: "Spanish - B2", type: "learning", ownerId }, ACTOR);
    await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", direction: "Ship it", ownerId }, ACTOR);
    const tools = toolsOf(db, ownerId);

    const rows = ((await tools.get("list_projects")!({})).structuredContent as { projects: Record<string, unknown>[] }).projects;
    expect(rows.find((p) => p.key === "spanish")).toEqual({ key: "spanish", name: "Spanish - B2", type: "learning", direction: null });
    expect(rows.find((p) => p.key === "apm")!.direction).toBe("Ship it");
  });
});

/**
 * The server's `instructions` (`CTX-10`). This is the only guidance a model sees *before* deciding to call
 * anything, which is why it exists at all: "the protocol matters" stated inside the protocol reaches nobody
 * who has not already called `get_project`.
 */
describe("server instructions orient a caller before any tool call", () => {
  it("names the first call, the protocol, and search, and stays short", () => {
    expect(INSTRUCTIONS).toContain("get_project");
    expect(INSTRUCTIONS).toContain("protocol");
    expect(INSTRUCTIONS).toContain("search_plan");
    // Not a tool inventory: the client already has every name, description and input schema, so restating
    // them would spend always-on context on something already supplied.
    for (const tool of ["list_items", "edit_item", "set_status", "list_context", "delete_comment"]) {
      expect(INSTRUCTIONS).not.toContain(tool);
    }
    // Always-on context, so a budget rather than a preference. Roughly 250 tokens.
    expect(INSTRUCTIONS.length).toBeLessThan(1200);
  });
});

/**
 * Everything the tool surface says is read by an agent working on *somebody else's* project, and two habits
 * from writing this repo leak into it in a way nothing else catches.
 *
 * **A plan ref names nothing to the reader.** `add_comment`'s refusal cited `(CTX-15)` for a fortnight: a
 * ticket in this backlog, meaningless in a health tracker, and worth going to look for. Operator-facing
 * errors are the exception and are not scanned - somebody reading a boot failure is deploying this.
 *
 * **A tool named in prose has to exist.** `query_measurements` sent the categorical case to
 * `list_measurements`, which never existed, so the one hint that fires when the numeric aggregate comes back
 * empty pointed at nothing.
 *
 * **Scanned from the source rather than from the registered tools**, which was the first attempt and missed
 * the bug it was written for: `list_measurements` was in a *reply*, built inside a handler, and only the
 * descriptions are reachable through a stub server. A caller reads both, so both have to be covered, and the
 * only place they sit together is the file.
 */
describe("the tool surface speaks to a caller who does not have this backlog", () => {
  /** Files whose string literals a caller reads. Not `http.ts` or `runtime.ts`: those speak to an operator,
   *  who is deploying this repo and can look a ref up. */
  const SPOKEN = ["src/mcp/tools.ts", "src/domain/comments.ts"];

  /** Every string literal in the file, with comment lines dropped first - a docblock citing `CTX-15` is the
   *  right place for it, and is exactly what this must not flag. */
  function spoken(file: string): string[] {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    return [...code.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? "");
  }

  // A *citation*, not any ref: the house style is a trailing `(CTX-15)`, so a lone parenthesised ref is the
  // thing to catch. A bare one is usually the opposite - `create_item` says "e.g. MCP-7" to show a caller what
  // a ref looks like, which is the format and not a claim that this backlog's MCP-7 is worth reading. Areas
  // are open-ended, so there is no set of prefixes to check against and shape is all there is to go on.
  const CITATION = /\((?:see )?[A-Z]{2,6}-\d[\d.]*(?:(?:,| and) [A-Z]{2,6}-\d[\d.]*)*\)/;

  // Verb-prefixed, because that is the tool naming convention and it is what separates a tool name from
  // `body_weight`, `text_value` or `sort_path`.
  const TOOLISH = /\b(?:list|get|set|add|create|edit|delete|record|query|search|open)_[a-z_]+\b/g;

  it("cites no ticket from this project's plan", () => {
    for (const file of SPOKEN) {
      for (const line of spoken(file)) expect(`${file}: ${line}`).not.toMatch(CITATION);
    }
    expect(INSTRUCTIONS).not.toMatch(CITATION);
  });

  it("names only tools that exist", () => {
    const registered = new Set<string>();
    const stub = { registerTool: (name: string) => registered.add(name) } as unknown as McpServer;
    registerTools(
      stub,
      {} as unknown as Database,
      { persist: async () => {}, refresh: async () => false, appendMeasurements: async () => {} },
      { open: async () => "", close: async () => {} },
      { ownerId: "owner" },
    );
    for (const file of [...SPOKEN, null]) {
      for (const line of file === null ? [INSTRUCTIONS] : spoken(file)) {
        for (const [mentioned] of line.matchAll(TOOLISH)) {
          expect(`${mentioned}: ${registered.has(mentioned) ? "exists" : line}`).toBe(`${mentioned}: exists`);
        }
      }
    }
  });
});

// Its own database, because the shared one above backs near-miss tests that list every ref in the project.
describe("planned dates on items (CAL-1)", () => {
  let dated: Map<string, Handler>;

  beforeAll(async () => {
    const { db, ownerId } = await freshDb();
    await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    dated = toolsOf(db, ownerId);
  });

  it("takes planned dates on create and edit, and shows them on the item's line (CAL-1)", async () => {
    const created = await dated.get("create_item")!({ project: "apm", area: "CAL", title: "trip", start: "2026-11-02", due: "2026-11-06" });
    expect(said(created)).toContain("CAL-1 [to-do] trip (2026-11-02 to 2026-11-06)");
    expect(said(await dated.get("edit_item")!({ project: "apm", ref: "CAL-1", start: null }))).toContain("trip (due 2026-11-06)");
    expect(said(await dated.get("list_items")!({ project: "apm", area: "CAL" }))).toContain("trip (due 2026-11-06)");
    expect(said(await dated.get("get_item")!({ project: "apm", ref: "CAL-1" }))).toContain("trip (due 2026-11-06)");
    const refused = await dated.get("edit_item")!({ project: "apm", ref: "CAL-1", due: "next tuesday" });
    expect(refused.isError).toBe(true);
    expect(said(refused)).toMatch(/not a calendar date/);
  });
});
