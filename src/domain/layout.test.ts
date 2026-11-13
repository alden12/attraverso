/**
 * The graph layout's memory (`VIEW-23.1`). The viewer owns what a position means; what is tested here is the
 * storage contract it relies on: a save replaces the whole layout, an unchanged save writes nothing, and the
 * event records only what moved.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb } from "../db/testing";
import { events } from "../db/schema";
import { createProject } from "./projects";
import { getLayout, setLayout } from "./layout";

const ACTOR = "test";

describe("the layout's memory (VIEW-23.1)", () => {
  it("replaces the whole layout, so a node the viewer no longer draws is forgotten", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await setLayout(db, p.id, { "area:MCP": { x: 0, y: 0 }, "MCP-1": { x: 10, y: 20 }, "MCP-2": { x: 260, y: 20 } }, ACTOR);
    await setLayout(db, p.id, { "area:MCP": { x: 0, y: 0 }, "MCP-1": { x: 10, y: 120 } }, ACTOR);
    expect(await getLayout(db, p.id)).toEqual({ "area:MCP": { x: 0, y: 0 }, "MCP-1": { x: 10, y: 120 } });
    await close();
  });

  it("records only what moved, and writes nothing when nothing did", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const layoutEvents = async () => (await db.select().from(events).where(eq(events.kind, "layout-changed")));
    await setLayout(db, p.id, { "area:MCP": { x: 0, y: 0 }, "MCP-1": { x: 10, y: 20 } }, ACTOR);
    await setLayout(db, p.id, { "area:MCP": { x: 0, y: 0 }, "MCP-1": { x: 10, y: 20 } }, ACTOR);
    expect(await layoutEvents()).toHaveLength(1);

    await setLayout(db, p.id, { "area:MCP": { x: 0, y: 0 }, "MCP-1": { x: 40, y: 20 } }, ACTOR);
    const [, moved] = await layoutEvents();
    expect(JSON.parse(String(moved!.after))).toEqual({ "MCP-1": { x: 40, y: 20 } });
    await close();
  });

  it("refuses a position that is not whole numbers, rather than storing what the viewer cannot read back", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await expect(setLayout(db, p.id, { "MCP-1": { x: 1.5, y: 0 } }, ACTOR)).rejects.toThrow(/whole-number/);
    await close();
  });
});
