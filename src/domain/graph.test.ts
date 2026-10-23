/**
 * The plan's graph structure (MCP-16 to MCP-19): dependency edges and the rules that keep them renderable,
 * ref allocation in its three forms, and soft deletion.
 *
 * These exist because the graph is the product. A wrong edge does not degrade a list, it draws a picture that
 * is not true, and until this work an agent could not write an edge at all - so the failure modes here have
 * never been exercised by anything but the importer, which only ever loaded a file a human had already made
 * consistent.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb } from "../db/testing";
import type { OwnedProjectId } from "./owned";
import { dependencies, events } from "../db/schema";
import { createProject } from "./projects";
import { createItem, deleteItem, editItem, getItem, getItemDetail, listItems } from "./items";
import { getNext, setNext } from "./next";
import { isNestedUnder, parentRef, splitScope } from "../../scripts/tickets";

const ACTOR = "test";

/** A project with `count` plain tickets in one area, so a test can get to the interesting part in one line. */
async function seeded(count: number) {
  const { db, ownerId, close } = await freshDb();
  const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
  for (let n = 1; n <= count; n++) await createItem(db, { projectId: p.id, area: "MCP", title: `ticket ${n}` }, ACTOR);
  return { db, close, projectId: p.id };
}

const depsOf = async (db: Awaited<ReturnType<typeof seeded>>["db"], projectId: OwnedProjectId, ref: string): Promise<string[]> =>
  (await getItemDetail(db, projectId, ref))!.deps;

describe("ref helpers", () => {
  it("reads a project scope off a ref, and refuses a malformed tail rather than inventing one", () => {
    expect(splitScope("apm:DIST-1")).toEqual({ project: "apm", ref: "DIST-1" });
    expect(splitScope("DIST-1")).toBeNull();
    // A tail that is not a ref falls through to the local path, which already refuses an unknown ref by name.
    expect(splitScope("apm:not a ref")).toBeNull();
    expect(splitScope(":DIST-1")).toBeNull();
  });

  it("derives parentage from the ref, and only at a dot boundary", () => {
    expect(parentRef("MCP-3")).toBeNull();
    expect(parentRef("MCP-3.1.2")).toBe("MCP-3.1");
    // The bug this guards: a bare startsWith makes MCP-30 a child of MCP-3, which only shows up once an area
    // has thirty tickets in it.
    expect(isNestedUnder("MCP-3", "MCP-3.1")).toBe(true);
    expect(isNestedUnder("MCP-3", "MCP-30")).toBe(false);
  });
});

describe("dependencies", () => {
  it("sets edges by ref and reads them back", async () => {
    const { db, close, projectId } = await seeded(3);
    await editItem(db, { projectId, ref: "MCP-1", deps: ["MCP-2", "MCP-3"] }, ACTOR);
    expect(await depsOf(db, projectId, "MCP-1")).toEqual(["MCP-2", "MCP-3"]);
    await close();
  });

  it("replaces the whole set rather than appending, so a wrong edit is correctable", async () => {
    const { db, close, projectId } = await seeded(3);
    await editItem(db, { projectId, ref: "MCP-1", deps: ["MCP-2", "MCP-3"] }, ACTOR);
    await editItem(db, { projectId, ref: "MCP-1", deps: ["MCP-3"] }, ACTOR);
    expect(await depsOf(db, projectId, "MCP-1")).toEqual(["MCP-3"]);
    await editItem(db, { projectId, ref: "MCP-1", deps: [] }, ACTOR);
    expect(await depsOf(db, projectId, "MCP-1")).toEqual([]);
    await close();
  });

  it("can be set at creation, including onto a ticket created moments earlier", async () => {
    const { db, close, projectId } = await seeded(1);
    const child = await createItem(db, { projectId, area: "MCP", title: "second", deps: ["MCP-1"] }, ACTOR);
    expect(await depsOf(db, projectId, child.ref)).toEqual(["MCP-1"]);
    await close();
  });

  it("names an unknown ref rather than silently dropping the edge", async () => {
    const { db, close, projectId } = await seeded(2);
    await expect(editItem(db, { projectId, ref: "MCP-1", deps: ["MCP-9"] }, ACTOR)).rejects.toThrow(/no ticket "MCP-9"/);
    await close();
  });

  it("refuses a self-edge", async () => {
    const { db, close, projectId } = await seeded(1);
    await expect(editItem(db, { projectId, ref: "MCP-1", deps: ["MCP-1"] }, ACTOR)).rejects.toThrow(/cannot depend on itself/);
    await close();
  });

  it("refuses an edge that nesting already expresses, in either direction", async () => {
    const { db, close, projectId } = await seeded(1);
    await createItem(db, { projectId, parent: "MCP-1", title: "sub" }, ACTOR);
    await expect(editItem(db, { projectId, ref: "MCP-1.1", deps: ["MCP-1"] }, ACTOR)).rejects.toThrow(/already related by nesting/);
    await expect(editItem(db, { projectId, ref: "MCP-1", deps: ["MCP-1.1"] }, ACTOR)).rejects.toThrow(/already related by nesting/);
    await close();
  });

  it("refuses a cycle and reports the path that would close it", async () => {
    const { db, close, projectId } = await seeded(3);
    await editItem(db, { projectId, ref: "MCP-1", deps: ["MCP-2"] }, ACTOR);
    await editItem(db, { projectId, ref: "MCP-2", deps: ["MCP-3"] }, ACTOR);
    // A bare refusal would make the caller guess which of several edges was the problem.
    await expect(editItem(db, { projectId, ref: "MCP-3", deps: ["MCP-1"] }, ACTOR)).rejects.toThrow(
      "that would create a dependency cycle: MCP-3 -> MCP-1 -> MCP-2 -> MCP-3",
    );
    await close();
  });

  it("rolls the whole edit back when one edge in it would close a cycle", async () => {
    const { db, close, projectId } = await seeded(4);
    await editItem(db, { projectId, ref: "MCP-1", deps: ["MCP-2"] }, ACTOR);
    await expect(editItem(db, { projectId, ref: "MCP-2", deps: ["MCP-3", "MCP-1"] }, ACTOR)).rejects.toThrow(/cycle/);
    // MCP-3 must not have survived: a partially applied dependency set is worse than a rejected one.
    expect(await depsOf(db, projectId, "MCP-2")).toEqual([]);
    await close();
  });

  it("allows a long legitimate chain, which is the check that matters most", async () => {
    // An over-eager cycle check that rejects a deep valid chain is worse than none: it blocks real work
    // rather than a mistake, and does it silently enough to look like a rule.
    const { db, close, projectId } = await seeded(6);
    for (let n = 1; n < 6; n++) await editItem(db, { projectId, ref: `MCP-${n}`, deps: [`MCP-${n + 1}`] }, ACTOR);
    expect(await depsOf(db, projectId, "MCP-1")).toEqual(["MCP-2"]);
    // and a diamond, where two paths reconverge without ever forming a cycle
    await editItem(db, { projectId, ref: "MCP-1", deps: ["MCP-2", "MCP-3"] }, ACTOR);
    await editItem(db, { projectId, ref: "MCP-3", deps: ["MCP-4"] }, ACTOR);
    expect(await depsOf(db, projectId, "MCP-1")).toEqual(["MCP-2", "MCP-3"]);
    await close();
  });

  it("logs what the edges were and became, which the item row cannot carry", async () => {
    const { db, close, projectId } = await seeded(2);
    await editItem(db, { projectId, ref: "MCP-1", deps: ["MCP-2"] }, ACTOR);
    const logged = await db.select().from(events).where(eq(events.kind, "edited"));
    expect(JSON.parse(logged.at(-1)!.before!).deps).toEqual([]);
    expect(JSON.parse(logged.at(-1)!.after!).deps).toEqual(["MCP-2"]);
    await close();
  });
});

describe("ref allocation", () => {
  it("allocates the next ref in an area", async () => {
    const { db, close, projectId } = await seeded(2);
    const next = await createItem(db, { projectId, area: "MCP", title: "third" }, ACTOR);
    expect(next.ref).toBe("MCP-3");
    await close();
  });

  it("allocates sub-tickets beneath a parent, deriving nesting from the ref", async () => {
    const { db, close, projectId } = await seeded(1);
    const first = await createItem(db, { projectId, parent: "MCP-1", title: "sub one" }, ACTOR);
    const second = await createItem(db, { projectId, parent: "MCP-1", title: "sub two" }, ACTOR);
    const deeper = await createItem(db, { projectId, parent: "MCP-1.2", title: "sub sub" }, ACTOR);
    expect([first.ref, second.ref, deeper.ref]).toEqual(["MCP-1.1", "MCP-1.2", "MCP-1.2.1"]);
    expect(deeper.areaKey).toBe("MCP"); // the area comes from the parent, not from a repeated argument
    expect(deeper.parentId).toBe(second.id);
    // sort_path must keep numeric order under nesting, or the viewer and every listing disagree
    expect(deeper.sortPath).toBe("000001.000002.000001");
    await close();
  });

  it("takes an explicit ref, which is what migrating an existing id scheme needs", async () => {
    const { db, close, projectId } = await seeded(0);
    const item = await createItem(db, { projectId, ref: "DATA-40", title: "imported" }, ACTOR);
    expect([item.ref, item.areaKey, item.sortPath]).toEqual(["DATA-40", "DATA", "000040"]);
    // and the watermark moves with it, so the next automatic ref does not collide with what was just claimed
    const next = await createItem(db, { projectId, area: "DATA", title: "after" }, ACTOR);
    expect(next.ref).toBe("DATA-41");
    await close();
  });

  it("takes an explicit dotted ref, attaching it to the parent the ref names", async () => {
    const { db, close, projectId } = await seeded(1);
    const sub = await createItem(db, { projectId, ref: "MCP-1.3", title: "third sub" }, ACTOR);
    expect(sub.parentId).toBe((await getItem(db, projectId, "MCP-1"))!.id);
    // allocation continues from the explicit one rather than colliding with it
    expect((await createItem(db, { projectId, parent: "MCP-1", title: "next" }, ACTOR)).ref).toBe("MCP-1.4");
    await close();
  });

  it("gives concurrent creates distinct refs", async () => {
    // Claude Code parallelises independent tool calls by design, so "create five tickets" arrives as five
    // overlapping calls, not five sequential ones. `max(sort_path) + 1` is a classic read-modify-write race
    // when the transactions overlap.
    //
    // Measured 2026-07-29 as safe, and that measurement was engine-specific in a way nobody noticed: PGlite
    // runs one connection and serialises `db.transaction` itself, so the transactions never actually
    // overlapped. On 2026-08-09 this test was the single failure when the suite first ran against server
    // Postgres (OPS-2) - twenty parallel creates, duplicate key on `items_project_ref`. `allocate` now takes
    // a per-project advisory lock, so the property is implemented rather than inherited, and this test is
    // only meaningful when run against Postgres (`yarn test:pg`), where the concurrency is real.
    const { db, close, projectId } = await seeded(0);
    const made = await Promise.all(
      Array.from({ length: 20 }, (_, n) => createItem(db, { projectId, area: "MCP", title: `parallel ${n}` }, ACTOR)),
    );
    expect(new Set(made.map((i) => i.ref)).size).toBe(20);
    expect((await listItems(db, { projectId })).map((i) => i.ref)).toContain("MCP-20");
    await close();
  });

  it("rejects a malformed ref, a taken one, and one whose parent does not exist", async () => {
    const { db, close, projectId } = await seeded(1);
    await expect(createItem(db, { projectId, ref: "not a ref", title: "x" }, ACTOR)).rejects.toThrow(/not a valid ref/);
    await expect(createItem(db, { projectId, ref: "MCP-1", title: "x" }, ACTOR)).rejects.toThrow(/already taken by: ticket 1/);
    await expect(createItem(db, { projectId, ref: "MCP-9.1", title: "x" }, ACTOR)).rejects.toThrow(/no ticket "MCP-9"/);
    await expect(createItem(db, { projectId, title: "x" }, ACTOR)).rejects.toThrow(/give an area/);
    await close();
  });
});

describe("soft deletion", () => {
  it("takes the ticket out of the plan but keeps it readable and its ref spent", async () => {
    const { db, close, projectId } = await seeded(2);
    const deleted = await deleteItem(db, { projectId, ref: "MCP-2" }, ACTOR);
    expect(deleted.deletedAt).not.toBeNull();
    expect((await listItems(db, { projectId })).map((i) => i.ref)).toEqual(["MCP-1"]);
    // still resolvable, so a note or body mentioning it reads as deleted rather than as a broken reference
    expect((await getItemDetail(db, projectId, "MCP-2"))?.item.title).toBe("ticket 2");
    // and the ref stays spent, or every mention of MCP-2 silently retargets
    expect((await createItem(db, { projectId, area: "MCP", title: "new" }, ACTOR)).ref).toBe("MCP-3");
    await close();
  });

  it("drops dependency edges in both directions, so nothing renders an edge to nothing", async () => {
    const { db, close, projectId } = await seeded(3);
    await editItem(db, { projectId, ref: "MCP-1", deps: ["MCP-2"] }, ACTOR);
    await editItem(db, { projectId, ref: "MCP-2", deps: ["MCP-3"] }, ACTOR);
    await deleteItem(db, { projectId, ref: "MCP-2" }, ACTOR);
    expect(await db.select().from(dependencies)).toHaveLength(0);
    await close();
  });

  it("refuses a ticket that still has sub-tickets, naming them", async () => {
    const { db, close, projectId } = await seeded(1);
    await createItem(db, { projectId, parent: "MCP-1", title: "sub" }, ACTOR);
    await expect(deleteItem(db, { projectId, ref: "MCP-1" }, ACTOR)).rejects.toThrow(/has sub-tickets \(MCP-1.1\)/);
    // once the child is gone the parent can go
    await deleteItem(db, { projectId, ref: "MCP-1.1" }, ACTOR);
    await expect(deleteItem(db, { projectId, ref: "MCP-1" }, ACTOR)).resolves.toBeDefined();
    await close();
  });

  it("refuses to delete twice, and logs the deletion", async () => {
    const { db, close, projectId } = await seeded(1);
    await deleteItem(db, { projectId, ref: "MCP-1" }, ACTOR);
    await expect(deleteItem(db, { projectId, ref: "MCP-1" }, ACTOR)).rejects.toThrow(/already deleted/);
    expect(await db.select().from(events).where(eq(events.kind, "deleted"))).toHaveLength(1);
    await close();
  });
});

/**
 * A dependency that names another project (`PROJ-11`), which is what stops `DIST-3`'s store split from
 * destroying every edge that crosses it. The state worth getting right is the third one: a scoped ref whose
 * project is not loaded is **valid**, because a clone of the public repo has one store file by construction.
 */
describe("a dependency that names another project (PROJ-11)", () => {
  /** Two projects in one runtime, which is what a split plan looks like once `IMP-17` has loaded both files. */
  async function twoProjects() {
    const { db, ownerId, close } = await freshDb();
    const core = await createProject(db, { key: "core", name: "Core", type: "software", ownerId }, ACTOR);
    const cloud = await createProject(db, { key: "cloud", name: "Cloud", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: core.id, area: "DIST", title: "the licence" }, ACTOR);
    await createItem(db, { projectId: cloud.id, area: "OPS", title: "packaging" }, ACTOR);
    return { db, close, core: core.id, cloud: cloud.id };
  }

  it("resolves an edge into a project that is loaded, and reads it back scoped", async () => {
    const { db, close, cloud } = await twoProjects();
    await editItem(db, { projectId: cloud, ref: "OPS-1", deps: ["core:DIST-1"] }, ACTOR);
    expect(await depsOf(db, cloud, "OPS-1")).toEqual(["core:DIST-1"]);
    await close();
  });

  it("accepts an edge into a project that is not here at all, which is the whole point", async () => {
    const { db, close, cloud } = await twoProjects();
    // Nobody has a project called `nowhere`: from a public clone, every commercial ref looks like this.
    await editItem(db, { projectId: cloud, ref: "OPS-1", deps: ["nowhere:OPS-4"] }, ACTOR);
    expect(await depsOf(db, cloud, "OPS-1")).toEqual(["nowhere:OPS-4"]);
    await close();
  });

  it("refuses a ref the loaded project does not have, because that one is wrong rather than unresolvable", async () => {
    const { db, close, cloud } = await twoProjects();
    await expect(editItem(db, { projectId: cloud, ref: "OPS-1", deps: ["core:DIST-99"] }, ACTOR)).rejects.toThrow(
      /no item "DIST-99" in project "core", which is loaded/,
    );
    await close();
  });

  it("normalises a scope naming the item's own project into a plain ref", async () => {
    const { db, close, core } = await twoProjects();
    await createItem(db, { projectId: core, area: "DIST", title: "the packages" }, ACTOR);
    // Written the long way, stored the short way: one representation of a within-project edge, so cycle
    // detection and blocking still run over the whole of the graph they think they cover.
    await editItem(db, { projectId: core, ref: "DIST-2", deps: ["core:DIST-1"] }, ACTOR);
    expect(await depsOf(db, core, "DIST-2")).toEqual(["DIST-1"]);
    await close();
  });

  it("does not block, because an unresolved edge cannot be known to be unfinished", async () => {
    const { db, close, cloud } = await twoProjects();
    await editItem(db, { projectId: cloud, ref: "OPS-1", deps: ["nowhere:OPS-4"] }, ACTOR);
    await setNext(db, cloud, ["OPS-1"], ACTOR);
    // A clone of the public repo would otherwise show a board blocked by items its reader cannot see, with
    // no way to act on any of them.
    expect((await getNext(db, cloud)).map((n) => n.blockedBy)).toEqual([[]]);
    await close();
  });

  it("keeps local and scoped edges side by side on one item", async () => {
    const { db, close, cloud, core } = await twoProjects();
    await createItem(db, { projectId: cloud, area: "OPS", title: "transport" }, ACTOR);
    await editItem(db, { projectId: cloud, ref: "OPS-2", deps: ["OPS-1", "core:DIST-1", "nowhere:X-1"] }, ACTOR);
    // Local first by (area, sort_path), then scoped by project then ref: a scoped target may not be loaded to
    // have a sort path, so it cannot be interleaved without the order depending on what else is open.
    expect(await depsOf(db, cloud, "OPS-2")).toEqual(["OPS-1", "core:DIST-1", "nowhere:X-1"]);
    expect(await depsOf(db, core, "DIST-1")).toEqual([]);
    await close();
  });
});
