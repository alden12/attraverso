/**
 * What the `measurements` schema itself enforces (`METRIC-1`). Not the domain layer - there isn't one yet
 * (`METRIC-2`) - just the guarantees a constraint gives that a convention cannot.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb } from "./testing";
import { items, measurements, projects } from "./schema";

const project = (db: Awaited<ReturnType<typeof freshDb>>["db"], ownerId: string) =>
  db.insert(projects).values({ key: "health", name: "Health", status: "active", type: "health", ownerId }).returning();

const reading = (projectId: string, over: Partial<typeof measurements.$inferInsert> = {}) => ({
  projectId,
  metric: "kcal",
  value: 2024,
  at: "2026-08-14T20:00:00.000Z",
  actor: "test",
  ...over,
});

describe("the measurements schema (METRIC-1)", () => {
  it("takes a numeric reading and a categorical one, but refuses both on one row", async () => {
    const { db, ownerId, close } = await freshDb();
    const [p] = await project(db, ownerId);

    await db.insert(measurements).values(reading(p!.id));
    await db.insert(measurements).values(reading(p!.id, { metric: "sleep_quality", value: null, textValue: "restless" }));

    // A row nobody could interpret. A convention would have let it through; the constraint is what makes the
    // "exactly one reading" rule true rather than merely intended.
    await expect(db.insert(measurements).values(reading(p!.id, { textValue: "restless" }))).rejects.toThrow();
    await close();
  });

  it("allows a parent with no reading at all, because an occurrence is not a definition", async () => {
    // A "workout" row with both columns null happened, at a time - which is what this table is for. The thing
    // kept out is a *definition* ("sleep_duration is in hours"), which is undated and revisable.
    const { db, ownerId, close } = await freshDb();
    const [p] = await project(db, ownerId);

    const [workout] = await db
      .insert(measurements)
      .values(reading(p!.id, { metric: "workout", value: null, label: "Tuesday push" }))
      .returning();
    await db.insert(measurements).values(reading(p!.id, { metric: "bench_press_weight", value: 80, unit: "kg", parentId: workout!.id }));

    expect(await db.select().from(measurements).where(eq(measurements.parentId, workout!.id))).toHaveLength(1);
    await close();
  });

  it("cascades a tree away with its item, and leaves project-level readings alone", async () => {
    const { db, ownerId, close } = await freshDb();
    const [p] = await project(db, ownerId);
    const [item] = await db
      .insert(items)
      .values({ projectId: p!.id, ref: "LIFT-1", areaKey: "LIFT", sortPath: "000001", title: "Bench press", status: "to-do" })
      .returning();

    const [session] = await db.insert(measurements).values(reading(p!.id, { metric: "session", value: null, itemId: item!.id })).returning();
    // The child carries the same subject, denormalised from its root: aggregation is the hot path and must
    // not walk to the root to find out whose reading this is.
    await db.insert(measurements).values(reading(p!.id, { metric: "working_weight", value: 80, itemId: item!.id, parentId: session!.id }));
    await db.insert(measurements).values(reading(p!.id, { metric: "body_weight", value: 78.4 })); // subject = the project

    await db.delete(items).where(eq(items.id, item!.id));
    // Both the session and its child went; the project-level reading is untouched, which is the whole point
    // of a null `item_id` meaning "the project" rather than "unplaced".
    const left = await db.select().from(measurements);
    expect(left.map((m) => m.metric)).toEqual(["body_weight"]);
    await close();
  });
});
