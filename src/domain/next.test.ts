/**
 * The agreed work order (`PROJ-8`). Two rules carry the weight here and both are easy to get wrong later:
 * the list is filtered on read rather than cleaned up on write, and an unmet dependency is reported rather
 * than refused.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb } from "../db/testing";
import { projectNext } from "../db/schema";
import { createProject } from "./projects";
import { createItem, deleteItem, setStatus } from "./items";
import { getNext, setNext } from "./next";

const ACTOR = "test";
const project = (db: Awaited<ReturnType<typeof freshDb>>["db"], ownerId: string) =>
  createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);

describe("the agreed order (PROJ-8)", () => {
  it("stores the given order and reads it back in it", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const title of ["one", "two", "three"]) await createItem(db, { projectId: p.id, area: "MCP", title }, ACTOR);

    await setNext(db, p.id, ["MCP-3", "MCP-1"], ACTOR);
    expect((await getNext(db, p.id)).map((n) => n.ref)).toEqual(["MCP-3", "MCP-1"]);

    // Rewritten wholesale, so a reorder is a reorder rather than an append: the second call must not leave
    // MCP-3 behind at position 0, which is exactly what an add/remove interface would do.
    await setNext(db, p.id, ["MCP-2", "MCP-3"], ACTOR);
    expect((await getNext(db, p.id)).map((n) => n.ref)).toEqual(["MCP-2", "MCP-3"]);
    expect(await db.select().from(projectNext).where(eq(projectNext.projectId, p.id))).toHaveLength(2);

    expect(await setNext(db, p.id, [], ACTOR)).toEqual([]);
    await close();
  });

  it("drops a done item on read without removing the row", async () => {
    // The rule the whole design turns on: mutating the list when a status changes would be stored state
    // derived from other stored state, which this model refuses everywhere else. Reopening the item has to
    // bring it back where it was, and that only works if nothing was deleted.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const title of ["one", "two"]) await createItem(db, { projectId: p.id, area: "MCP", title }, ACTOR);
    await setNext(db, p.id, ["MCP-1", "MCP-2"], ACTOR);

    await setStatus(db, { projectId: p.id, ref: "MCP-1", status: "done" }, ACTOR);
    expect((await getNext(db, p.id)).map((n) => n.ref)).toEqual(["MCP-2"]);
    expect(await db.select().from(projectNext).where(eq(projectNext.projectId, p.id))).toHaveLength(2);

    await setStatus(db, { projectId: p.id, ref: "MCP-1", status: "to-do" }, ACTOR);
    expect((await getNext(db, p.id)).map((n) => n.ref)).toEqual(["MCP-1", "MCP-2"]); // back in its old position
    await close();
  });

  it("drops an item in review, and brings it back when the review sends it back", async () => {
    // `review` means the pull request is up, so the work has left your hands - leaving it at position one is
    // the list reporting finished work as the thing to do next. And this is the case where filtering on read
    // earns its keep: a rejected review reverses routinely, where done rarely does.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const title of ["one", "two"]) await createItem(db, { projectId: p.id, area: "MCP", title }, ACTOR);
    await setNext(db, p.id, ["MCP-1", "MCP-2"], ACTOR);

    await setStatus(db, { projectId: p.id, ref: "MCP-1", status: "review" }, ACTOR);
    expect((await getNext(db, p.id)).map((n) => n.ref)).toEqual(["MCP-2"]);

    await setStatus(db, { projectId: p.id, ref: "MCP-1", status: "in-progress" }, ACTOR);
    expect((await getNext(db, p.id)).map((n) => n.ref)).toEqual(["MCP-1", "MCP-2"]); // back at position one
    await close();
  });

  it("still counts a dependency in review as a blocker, because it is not merged", async () => {
    // "Cannot be picked up" and "no longer blocks" are different questions, and NOT_ACTIONABLE only answers
    // the first. An open pull request does not unblock the thing waiting on it.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await createItem(db, { projectId: p.id, area: "DATA", title: "schema" }, ACTOR);
    await createItem(db, { projectId: p.id, area: "MCP", title: "server", deps: ["DATA-1"] }, ACTOR);
    await setNext(db, p.id, ["MCP-1"], ACTOR);

    await setStatus(db, { projectId: p.id, ref: "DATA-1", status: "review" }, ACTOR);
    // And it reports the status, so a project that builds on unmerged branches can tell "a merge away" from
    // "nobody has started it" without a second call.
    expect((await getNext(db, p.id))[0]?.blockedBy).toEqual([{ ref: "DATA-1", status: "review" }]);
    await close();
  });

  it("drops a soft-deleted item on read, which no cascade would have caught", async () => {
    // `ON DELETE CASCADE` is on the table and will essentially never fire: there is no hard-delete path.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const title of ["one", "two"]) await createItem(db, { projectId: p.id, area: "MCP", title }, ACTOR);
    await setNext(db, p.id, ["MCP-1", "MCP-2"], ACTOR);

    await deleteItem(db, { projectId: p.id, ref: "MCP-2" }, ACTOR);
    expect((await getNext(db, p.id)).map((n) => n.ref)).toEqual(["MCP-1"]);
    expect(await db.select().from(projectNext).where(eq(projectNext.projectId, p.id))).toHaveLength(2);
    await close();
  });

  it("flags an item whose dependencies are unmet rather than refusing it", async () => {
    // Wanting to do something before it is unblocked is a real intention, and usually the reason to go
    // unblock the dependency. Refusing would make the list lie about what was agreed.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await createItem(db, { projectId: p.id, area: "DATA", title: "schema" }, ACTOR);
    await createItem(db, { projectId: p.id, area: "MCP", title: "server", deps: ["DATA-1"] }, ACTOR);

    const list = await setNext(db, p.id, ["MCP-1"], ACTOR);
    expect(list).toEqual([{ ref: "MCP-1", status: "to-do", title: "server", blockedBy: [{ ref: "DATA-1", status: "to-do" }] }]);

    await setStatus(db, { projectId: p.id, ref: "DATA-1", status: "done" }, ACTOR);
    expect((await getNext(db, p.id))[0]?.blockedBy).toEqual([]);
    await close();
  });

  it("does not count a deleted dependency as a blocker", async () => {
    // It can never become done, so calling it a blocker would mark the item permanently stuck on something
    // nobody intends to do.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await createItem(db, { projectId: p.id, area: "DATA", title: "schema" }, ACTOR);
    await createItem(db, { projectId: p.id, area: "MCP", title: "server", deps: ["DATA-1"] }, ACTOR);
    await setNext(db, p.id, ["MCP-1"], ACTOR);

    await deleteItem(db, { projectId: p.id, ref: "DATA-1" }, ACTOR);
    expect((await getNext(db, p.id))[0]?.blockedBy).toEqual([]);
    await close();
  });

  it("refuses a ref naming no item, and names it", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    await expect(setNext(db, p.id, ["MCP-1", "MCP-9"], ACTOR)).rejects.toThrow(/no item "MCP-9"/);
    // Refused wholesale: a partly-applied order is worse than none, because nobody can tell which half took.
    expect(await getNext(db, p.id)).toEqual([]);
    await close();
  });

  it("deduplicates rather than refusing a repeat", async () => {
    // The primary key would reject it anyway, and "you listed MCP-1 twice" is not a decision worth making.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const title of ["one", "two"]) await createItem(db, { projectId: p.id, area: "MCP", title }, ACTOR);
    expect((await setNext(db, p.id, ["MCP-1", "MCP-2", "MCP-1"], ACTOR)).map((n) => n.ref)).toEqual(["MCP-1", "MCP-2"]);
    await close();
  });
});
