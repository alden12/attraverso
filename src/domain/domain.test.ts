/**
 * Domain-layer tests against the real schema: project and item CRUD, ref allocation, status transitions, and
 * the invariant that every mutation writes an event row in the same transaction.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { freshDb } from "../db/testing";
import { comments, dependencies, events } from "../db/schema";
import { createProject, createProjectWithDefaults, DEFAULT_PROTOCOL, getProjectByKey, listProjects, setDirection } from "./projects";
import { listSections } from "./context";
import { createItem, editItem, getItem, getItemDetail, listItems, setStatus } from "./items";
import { addComment } from "./comments";

const ACTOR = "test";

describe("projects", () => {
  it("creates, lists and looks up by key, and rejects a duplicate key", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    expect(p.status).toBe("active");
    expect(await listProjects(db, ownerId)).toHaveLength(1);
    expect((await getProjectByKey(db, ownerId, "apm"))?.id).toBe(p.id);
    await expect(createProject(db, { key: "apm", name: "again", type: "software", ownerId }, ACTOR)).rejects.toThrow(/already exists/);
    await close();
  });

  it("seeds a new project with the default protocol context section", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProjectWithDefaults(db, { key: "es", name: "Spanish", type: "learning", ownerId }, ACTOR);
    const sections = await listSections(db, p.id);
    expect(sections.map((s) => s.heading)).toEqual([DEFAULT_PROTOCOL.heading]);
    expect(sections[0]?.content).toMatch(/markdown/i); // the protocol states the body/context format
    // and it carries the onboarding interview, marked so a session knows to run it and then remove it
    expect(sections[0]?.content).toMatch(/not filled in yet/i);
    expect(sections[0]?.content).toMatch(/set_context/);
    // plain createProject stays blank, so tests and non-tool paths can opt out of the defaults
    const bare = await createProject(db, { key: "bare", name: "Bare", type: "software", ownerId }, ACTOR);
    expect(await listSections(db, bare.id)).toHaveLength(0);
    await close();
  });

  it("revises direction and logs before/after", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const updated = await setDirection(db, p.id, "Ship the MVP", ACTOR);
    expect(updated.direction).toBe("Ship the MVP");
    const changes = await db.select().from(events).where(eq(events.kind, "direction-changed"));
    expect(changes).toHaveLength(1);
    expect(JSON.parse(changes[0]!.after!).direction).toBe("Ship the MVP");
    await close();
  });
});

describe("items", () => {
  it("allocates sequential refs per area and orders by sort_path", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const a = await createItem(db, { projectId: p.id, area: "mcp", title: "server skeleton" }, ACTOR);
    const b = await createItem(db, { projectId: p.id, area: "MCP", title: "tools" }, ACTOR);
    const c = await createItem(db, { projectId: p.id, area: "data", title: "schema" }, ACTOR);
    expect([a.ref, b.ref, c.ref]).toEqual(["MCP-1", "MCP-2", "DATA-1"]); // area case-normalised, per-area counters
    expect(a.status).toBe("to-do");
    const listed = await listItems(db, { projectId: p.id });
    expect(listed.map((i) => i.ref)).toEqual(["DATA-1", "MCP-1", "MCP-2"]); // area then sort_path: DATA before MCP
    await close();
  });

  it("filters by area and status", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: p.id, area: "MCP", title: "one" }, ACTOR);
    await createItem(db, { projectId: p.id, area: "DATA", title: "two", status: "done" }, ACTOR);
    expect(await listItems(db, { projectId: p.id, area: "MCP" })).toHaveLength(1);
    expect(await listItems(db, { projectId: p.id, status: "done" })).toHaveLength(1);
    await close();
  });

  it("changes status, stamps closed_at on done, and logs before/after", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const item = await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    const done = await setStatus(db, { projectId: p.id, ref: item.ref, status: "done" }, ACTOR);
    expect(done.status).toBe("done");
    expect(done.closedAt).not.toBeNull();
    const reopened = await setStatus(db, { projectId: p.id, ref: item.ref, status: "to-do" }, ACTOR);
    expect(reopened.closedAt).toBeNull();

    const log = await db.select().from(events).where(and(eq(events.entityType, "item"), eq(events.kind, "status-changed")));
    expect(log).toHaveLength(2);
    await close();
  });

  it("reads a ticket in full: its body, its dependency refs and its comments", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const dep = await createItem(db, { projectId: p.id, area: "DATA", title: "schema", body: "the schema layer" }, ACTOR);
    const item = await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    await db.insert(dependencies).values({ itemId: item.id, dependsOnId: dep.id, createdAt: item.createdAt });
    await addComment(db, { projectId: p.id, body: "stdout banner bit us here", itemId: item.id }, ACTOR);
    // Inserted directly: `addComment` refuses these since `CTX-15`, and the point here is that a legacy
    // one is still excluded from an item's detail rather than leaking into it.
    await db.insert(comments).values({ projectId: p.id, itemId: null, body: "unrelated project-level thought", audience: "user", actor: ACTOR });

    const detail = await getItemDetail(db, p.id, "MCP-1");
    expect(detail?.item.title).toBe("server");
    expect(detail?.deps).toEqual(["DATA-1"]); // dep resolved to its human ref, not a uuid
    // Only this item's comments: an unattached project comment must not leak onto every ticket.
    expect(detail?.comments.map((n) => n.body)).toEqual(["stdout banner bit us here"]);
    expect((await getItemDetail(db, p.id, "DATA-1"))?.item.body).toBe("the schema layer");
    expect(await getItemDetail(db, p.id, "NOPE-1")).toBeNull();
    await close();
  });

  it("edits a ticket's title and body, and logs before/after", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: p.id, area: "MCP", title: "server", body: "the stdio server" }, ACTOR);

    const bodyOnly = await editItem(db, { projectId: p.id, ref: "MCP-1", body: "the stdio server (revised)" }, ACTOR);
    expect(bodyOnly.title).toBe("server"); // untouched field survives
    expect(bodyOnly.body).toBe("the stdio server (revised)");
    const both = await editItem(db, { projectId: p.id, ref: "MCP-1", title: "stdio server", body: "final" }, ACTOR);
    expect([both.title, both.body]).toEqual(["stdio server", "final"]);

    await expect(editItem(db, { projectId: p.id, ref: "MCP-1" }, ACTOR)).rejects.toThrow(/nothing to edit/);
    await expect(editItem(db, { projectId: p.id, ref: "NOPE-1", title: "x" }, ACTOR)).rejects.toThrow(/no ticket/);
    const edits = await db.select().from(events).where(and(eq(events.entityType, "item"), eq(events.kind, "edited")));
    expect(edits).toHaveLength(2); // one per successful edit; the failed calls logged nothing
    await close();
  });

  it("rejects an unknown status and a missing ref", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await expect(createItem(db, { projectId: p.id, area: "MCP", title: "x", status: "wip" }, ACTOR)).rejects.toThrow(/unknown status/);
    await expect(setStatus(db, { projectId: p.id, ref: "MCP-99", status: "done" }, ACTOR)).rejects.toThrow(/no ticket/);
    await close();
  });

  it("writes exactly one event per mutation", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR); // 1 event
    const item = await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR); // 1 event
    await setStatus(db, { projectId: p.id, ref: item.ref, status: "review" }, ACTOR); // 1 event
    // Scoped to the project: the fixture provisions its owner through `ensureUser`, which logs a `user created`
    // row of its own (OPS-4). That row is a mutation too, so counting it would be right - it just is not one of
    // the three this test is about.
    expect(await db.select().from(events).where(eq(events.projectId, p.id))).toHaveLength(3);
    // and the row it references still exists (event is same-transaction, not fire-and-forget)
    expect(await getItem(db, p.id, item.ref)).not.toBeNull();
    await close();
  });
});
