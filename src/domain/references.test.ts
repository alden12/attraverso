/**
 * Source references (`CTX-13`), slice 2: the table, the commit-time rule, and how the existing writes keep it.
 *
 * The rule is the one thing about references that is enforced rather than advisory - a live reference's pointer is
 * in its owner's text, and a key has one owner - so it is tested where it lives, in the database, by writing rows
 * directly: nothing creates a reference through a tool yet (slice 4). The domain half is that an edit removing a
 * pointer retires its reference instead of tripping the rule, and the load half that a plan whose pointer was
 * removed by hand still loads.
 */
import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { freshDb } from "../db/testing";
import { events, sourceReferences } from "../db/schema";
import { createProject } from "./projects";
import { createItem, editItem } from "./items";
import { setSection } from "./context";
import { hasPointer } from "./references";
import { exportStore, importStore } from "../serialise/plan";

const ACTOR = "test";

async function setup() {
  const fresh = await freshDb();
  const project = await createProject(fresh.db, { key: "apm", name: "AI PM", type: "software", ownerId: fresh.ownerId }, ACTOR);
  const item = await createItem(fresh.db, { projectId: project.id, area: "OPS", title: "hosting", body: "Neon runs Postgres 18.4 [ref r7k2]." }, ACTOR);
  return { ...fresh, project, item };
}

const reference = (projectId: string, owner: { itemId?: string; sectionId?: string }, key = "r7k2", source = "search") => ({
  projectId,
  key,
  itemId: owner.itemId ?? null,
  sectionId: owner.sectionId ?? null,
  source,
  detail: "https://neon.tech/docs",
  quotedText: "Neon runs Postgres 18.4",
  actor: ACTOR,
});

/** The database's own reason, under the "Failed query" error Drizzle wraps it in. */
async function refusal(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
  throw new Error("the write was not refused");
}

const live = async (db: Awaited<ReturnType<typeof freshDb>>["db"], key: string) =>
  db.select().from(sourceReferences).where(and(eq(sourceReferences.key, key), isNull(sourceReferences.retiredAt)));

describe("the pointer rule, at commit (CTX-13)", () => {
  it("accepts a reference whose pointer is in its item's text, and a second source on it", async () => {
    const { db, project, item, close } = await setup();
    await db.insert(sourceReferences).values(reference(project.id, { itemId: item.id }));
    await db.insert(sourceReferences).values(reference(project.id, { itemId: item.id }, "r7k2", "test"));
    expect(await live(db, "r7k2")).toHaveLength(2);
    await close();
  });

  it("refuses a reference whose pointer is not in the text", async () => {
    const { db, project, item, close } = await setup();
    expect(await refusal(db.insert(sourceReferences).values(reference(project.id, { itemId: item.id }, "zz99")))).toMatch(/zz99 is live but its pointer/);
    await close();
  });

  it("refuses a body change that drops a live pointer behind the domain's back", async () => {
    const { db, project, item, close } = await setup();
    await db.insert(sourceReferences).values(reference(project.id, { itemId: item.id }));
    const { items } = await import("../db/schema");
    expect(await refusal(db.update(items).set({ body: "Neon runs Postgres 18.4." }).where(eq(items.id, item.id)))).toMatch(/r7k2 is live/);
    await close();
  });

  it("refuses one key owned by two items", async () => {
    const { db, project, item, close } = await setup();
    const other = await createItem(db, { projectId: project.id, area: "OPS", title: "other", body: "Also [ref r7k2]." }, ACTOR);
    await db.insert(sourceReferences).values(reference(project.id, { itemId: item.id }));
    expect(await refusal(db.insert(sourceReferences).values(reference(project.id, { itemId: other.id })))).toMatch(/more than one owner/);
    await close();
  });

  it("matches a pointer exactly, in either form, so r7k2 is not r7k29", () => {
    expect(hasPointer("x [ref r7k2].", "r7k2")).toBe(true);
    expect(hasPointer("x [ref r7k2: search 2026-08-10].", "r7k2")).toBe(true);
    expect(hasPointer("x [ref r7k29].", "r7k2")).toBe(false);
  });
});

describe("edits keep the rule rather than tripping it", () => {
  it("retires an item's reference when an edit removes its pointer, and records it on the event", async () => {
    const { db, project, item, close } = await setup();
    await db.insert(sourceReferences).values(reference(project.id, { itemId: item.id }));
    await editItem(db, { projectId: project.id, ref: item.ref, body: "Neon runs Postgres 18.6." }, ACTOR);
    expect(await live(db, "r7k2")).toHaveLength(0);
    const edited = (await db.select().from(events).where(eq(events.kind, "edited"))).at(-1)!;
    expect(String(edited.after)).toContain("retiredReferences");
    await close();
  });

  it("keeps a reference whose pointer survives the edit, expanded or not", async () => {
    const { db, project, item, close } = await setup();
    await db.insert(sourceReferences).values(reference(project.id, { itemId: item.id }));
    await editItem(db, { projectId: project.id, ref: item.ref, body: "Neon runs Postgres 18.6 [ref r7k2: search 2026-08-10]." }, ACTOR);
    expect(await live(db, "r7k2")).toHaveLength(1);
    await close();
  });

  it("retires a context section's reference the same way", async () => {
    const { db, project, close } = await setup();
    const section = await setSection(db, { projectId: project.id, heading: "Hosting", content: "Fly, not Workers [ref d4p1]." }, ACTOR);
    await db.insert(sourceReferences).values({ ...reference(project.id, { sectionId: section.id }, "d4p1", "user"), quotedText: "Fly, not Workers" });
    await setSection(db, { projectId: project.id, heading: "Hosting", content: "Fly, not Workers." }, ACTOR);
    expect(await live(db, "d4p1")).toHaveLength(0);
    await close();
  });
});

describe("loading a plan (CTX-13)", () => {
  it("round-trips references on items and in context sections", async () => {
    const { db, project, item, ownerId, close } = await setup();
    const section = await setSection(db, { projectId: project.id, heading: "Hosting", content: "Fly, not Workers [ref d4p1]." }, ACTOR);
    await db.insert(sourceReferences).values(reference(project.id, { itemId: item.id }));
    await db.insert(sourceReferences).values({ ...reference(project.id, { sectionId: section.id }, "d4p1", "user"), quotedText: "Fly, not Workers" });
    const exported = await exportStore(db, ownerId);
    const next = await freshDb();
    await importStore(next.db, exported);
    expect(await exportStore(next.db, next.ownerId)).toEqual(exported);
    await close();
    await next.close();
  });

  it("loads a plan whose pointer was removed by hand, and still lets the item be edited after", async () => {
    const { db, project, item, ownerId, close } = await setup();
    await db.insert(sourceReferences).values(reference(project.id, { itemId: item.id }));
    const exported = await exportStore(db, ownerId);
    const handEdited = structuredClone(exported);
    handEdited.projects[0]!.items[0]!.body = "Neon runs Postgres 18.4, pointer deleted by hand.";
    const next = await freshDb();
    await importStore(next.db, handEdited);
    expect(await live(next.db, "r7k2")).toHaveLength(1); // loaded as it was: stale, not refused
    const loaded = (await (await import("./projects")).getProjectByKey(next.db, next.ownerId, "apm"))!;
    await editItem(next.db, { projectId: loaded.id, ref: item.ref, title: "hosting, retitled", body: handEdited.projects[0]!.items[0]!.body }, ACTOR);
    expect(await live(next.db, "r7k2")).toHaveLength(0); // the next edit retires it rather than failing
    await close();
    await next.close();
  });
});
