/**
 * Smoke test for the Drizzle-over-PGlite storage layer: the schema builds, typed CRUD works, application
 * ids and timestamps default in, foreign-key cascades fire, and the hard queries (a WITH RECURSIVE
 * dependency closure) run through Drizzle's `sql` tag. This is the DATA-14 spike turned into a standing
 * guarantee against the real schema.
 */
import { describe, expect, it } from "vitest";
import { sql, eq } from "drizzle-orm";
import { freshDb } from "./testing";
import { rowsOf } from "./rows";
import { dependencies, items, projects } from "./schema";

/** The single row a `.returning()` was meant to produce. Throws on none, so `T | undefined` collapses to `T`. */
const only = <T>(rows: T[]): T => {
  const [row] = rows;
  if (row === undefined) throw new Error("expected exactly one row");
  return row;
};

const newProject = (db: Awaited<ReturnType<typeof freshDb>>["db"], ownerId: string) =>
  db.insert(projects).values({ key: "apm", name: "AI PM", status: "active", type: "software", ownerId }).returning();

const newItem = (db: Awaited<ReturnType<typeof freshDb>>["db"], projectId: string, ref: string, status = "to-do") =>
  db.insert(items).values({ projectId, ref, areaKey: ref.slice(0, ref.indexOf("-")), sortPath: ref, title: ref, status }).returning();

describe("storage layer (Drizzle over PGlite)", () => {
  it("builds the schema and defaults ids and timestamps", async () => {
    const { db, ownerId, close } = await freshDb();
    const project = only(await newProject(db, ownerId));
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/); // uuidv7 defaulted in the application
    expect(project.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/); // fixed-width ISO text
    await close();
  });

  it("does typed CRUD and enforces the unique ref per project", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = only(await newProject(db, ownerId));
    await newItem(db, p.id, "DATA-1");
    const rows = await db.select({ ref: items.ref, status: items.status }).from(items).where(eq(items.projectId, p.id));
    expect(rows).toEqual([{ ref: "DATA-1", status: "to-do" }]);

    await expect(newItem(db, p.id, "DATA-1")).rejects.toThrow(); // (project_id, ref) is unique
    await close();
  });

  it("cascades deletes from project through items and dependencies", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = only(await newProject(db, ownerId));
    const a = only(await newItem(db, p.id, "DATA-1", "done"));
    const b = only(await newItem(db, p.id, "DATA-2"));
    await db.insert(dependencies).values({ itemId: b.id, dependsOnId: a.id });

    await db.delete(projects).where(eq(projects.id, p.id));
    expect(await db.select().from(items)).toHaveLength(0);
    expect(await db.select().from(dependencies)).toHaveLength(0);
    await close();
  });

  it("runs a WITH RECURSIVE dependency closure through the sql tag", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = only(await newProject(db, ownerId));
    const x1 = only(await newItem(db, p.id, "X-1"));
    const x2 = only(await newItem(db, p.id, "X-2"));
    const x3 = only(await newItem(db, p.id, "X-3"));
    await db.insert(dependencies).values([
      { itemId: x3.id, dependsOnId: x2.id },
      { itemId: x2.id, dependsOnId: x1.id },
    ]);

    const closure = await db.execute(sql`
      WITH RECURSIVE reach(node) AS (
        SELECT depends_on_id FROM dependencies WHERE item_id = ${x3.id}
        UNION
        SELECT d.depends_on_id FROM reach r JOIN dependencies d ON d.item_id = r.node
      )
      SELECT node FROM reach`);
    const reached = rowsOf<{ node: string }>(closure)
      .map((r) => r.node)
      .sort();
    expect(reached).toEqual([x1.id, x2.id].sort()); // X-3 transitively depends on X-2 and X-1
    await close();
  });
});
