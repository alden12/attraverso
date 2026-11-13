/**
 * Areas as the project's map (`PROJ-8`/`VIEW-26` follow-on). The rule under test is that the *set* of areas
 * comes from the items and the metadata only decorates it - because filing an item writes no `areas` row (only
 * `setArea` does), so a listing driven by that table would omit every area nobody has named.
 */
import { describe, expect, it } from "vitest";
import { freshDb } from "../db/testing";
import { areas } from "../db/schema";
import { createProject } from "./projects";
import { createItem, deleteItem, setStatus } from "./items";
import { listAreas, MAX_AREA_DESCRIPTION, MAX_AREA_NAME, setArea } from "./areas";

const ACTOR = "test";
const project = (db: Awaited<ReturnType<typeof freshDb>>["db"], ownerId: string) =>
  createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);

describe("listAreas", () => {
  it("lists an area that has no metadata row, because creating an item does not create one", async () => {
    // The finding this module exists for: `createItem` sets `areaKey` on the item and stops. Listing the
    // `areas` table would have returned nothing at all here.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    expect(await db.select().from(areas)).toHaveLength(0);

    expect(await listAreas(db, p.id)).toEqual([{ key: "MCP", name: null, description: null, open: 1, total: 1 }]);
    await close();
  });

  it("counts open separately from total, and drops soft-deleted items from both", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const title of ["one", "two", "three"]) await createItem(db, { projectId: p.id, area: "MCP", title }, ACTOR);
    await setStatus(db, { projectId: p.id, ref: "MCP-1", status: "done" }, ACTOR);
    await deleteItem(db, { projectId: p.id, ref: "MCP-3" }, ACTOR);

    // A deleted item is in neither count: it is not work left, and it is not work that was done.
    expect(await listAreas(db, p.id)).toEqual([{ key: "MCP", name: null, description: null, open: 1, total: 2 }]);
    await close();
  });

  it("puts named areas in their stated order and unnamed ones after, alphabetically", async () => {
    // The named ones are the project's declared structure; an unnamed one is a prefix that appeared. Sorting
    // the declared ones first is the right way round.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const area of ["MCP", "DATA", "ZZZ", "AAA"]) await createItem(db, { projectId: p.id, area, title: "t" }, ACTOR);
    await db.insert(areas).values([
      { projectId: p.id, key: "DATA", name: "Storage", sortOrder: 1 },
      { projectId: p.id, key: "MCP", name: "The server", sortOrder: 2 },
    ]);

    expect((await listAreas(db, p.id)).map((a) => a.key)).toEqual(["DATA", "MCP", "AAA", "ZZZ"]);
    expect((await listAreas(db, p.id))[0]!.name).toBe("Storage");
    await close();
  });
});

describe("setArea (PROJ-3)", () => {
  it("names an area the first time, keeps what is not passed after that, and clears a description with null", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await createItem(db, { projectId: p.id, area: "VIEW", title: "graph" }, ACTOR);

    expect(await setArea(db, p.id, { key: "view", name: "Viewer" }, ACTOR)).toEqual({ key: "VIEW", name: "Viewer", description: null });
    await setArea(db, p.id, { key: "VIEW", description: "Everything you see in the browser." }, ACTOR);
    expect(await listAreas(db, p.id)).toEqual([
      { key: "VIEW", name: "Viewer", description: "Everything you see in the browser.", open: 1, total: 1 },
    ]);
    await setArea(db, p.id, { key: "VIEW", description: null }, ACTOR);
    expect((await listAreas(db, p.id))[0]).toMatchObject({ name: "Viewer", description: null });
    await close();
  });

  it("takes the key as the name when a first call only describes, and puts a new row after the named ones", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const area of ["MCP", "DATA"]) await createItem(db, { projectId: p.id, area, title: "x" }, ACTOR);
    await setArea(db, p.id, { key: "MCP", name: "The tools" }, ACTOR);
    await setArea(db, p.id, { key: "DATA", description: "Storage." }, ACTOR);
    // MCP was named first, so it still leads, rather than DATA's alphabetical place.
    expect((await listAreas(db, p.id)).map((a) => [a.key, a.name])).toEqual([
      ["MCP", "The tools"],
      ["DATA", "DATA"],
    ]);
    await close();
  });

  it("refuses a key that is not a prefix, an empty or overlong name, and a description past the cap, naming set_context", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await expect(setArea(db, p.id, { key: "VIEW-1", name: "x" }, ACTOR)).rejects.toThrow(/not an area key/);
    await expect(setArea(db, p.id, { key: "VIEW", name: "  " }, ACTOR)).rejects.toThrow(/cannot be empty/);
    await expect(setArea(db, p.id, { key: "VIEW", name: "x".repeat(MAX_AREA_NAME + 1) }, ACTOR)).rejects.toThrow(/description/);
    await expect(setArea(db, p.id, { key: "VIEW", description: "x".repeat(MAX_AREA_DESCRIPTION + 1) }, ACTOR)).rejects.toThrow(/set_context/);
    await close();
  });
});
