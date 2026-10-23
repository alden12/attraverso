/**
 * The measurement files (`METRIC-2`). The property that matters is the one the plan file gets from
 * `saveStore`: what was recorded survives a restart. It is reached differently here - appending rather than
 * rewriting - so it needs proving separately.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../db/testing";
import { measurements } from "../db/schema";
import { createProject } from "../domain/projects";
import { createItem } from "../domain/items";
import { allMeasurements, recordMeasurements } from "../domain/measurements";
import { appendMeasurements, loadMeasurements, measurementsDirFor, readMeasurements, toRecords } from "./measurements";

const ACTOR = "test";
const project = (db: Awaited<ReturnType<typeof freshDb>>["db"], ownerId: string) =>
  createProject(db, { key: "health", name: "Health", type: "health", ownerId }, ACTOR);

const tempDir = () => mkdtemp(join(tmpdir(), "apm-measurements-"));

describe("measurement files (METRIC-2)", () => {
  it("appends to the month of `at`, so a backfilled log lands in the month it is about", async () => {
    // Bucketing by the write instant instead would split a month across two files the first time anyone
    // recorded yesterday's entry after midnight, and neither file would be the record of that month.
    const dir = await tempDir();
    await appendMeasurements(dir, [
      { id: "a", project: "health", metric: "kcal", value: 2024, at: "2026-07-31T20:00:00.000Z", actor: ACTOR, created_at: "now" },
      { id: "b", project: "health", metric: "kcal", value: 1980, at: "2026-08-01T20:00:00.000Z", actor: ACTOR, created_at: "now" },
    ]);
    expect((await readdir(dir)).sort()).toEqual(["2026-07.yaml", "2026-08.yaml"]);
  });

  it("extends the sequence rather than rewriting it, which is the whole point of the split", async () => {
    const dir = await tempDir();
    const row = (id: string, value: number) => ({
      id,
      project: "health",
      metric: "kcal",
      value,
      at: "2026-08-14T20:00:00.000Z",
      actor: ACTOR,
      created_at: "now",
    });

    await appendMeasurements(dir, [row("a", 1)]);
    const first = await readFile(join(dir, "2026-08.yaml"), "utf8");
    await appendMeasurements(dir, [row("b", 2)]);
    const second = await readFile(join(dir, "2026-08.yaml"), "utf8");

    // The first write is still there byte for byte: nothing re-serialised it, so the diff of the second write
    // is exactly the row that arrived, and recording one number never costs a year of history.
    expect(second.startsWith(first)).toBe(true);
    expect((await readMeasurements(dir)).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("round-trips a tree through the files, resolving the subject by ref", async () => {
    const a = await freshDb();
    const p = await project(a.db, a.ownerId);
    const lift = await createItem(a.db, { projectId: p.id, area: "LIFT", title: "Bench press" }, ACTOR);
    const written = await recordMeasurements(
      a.db,
      {
        projectId: p.id,
        itemId: lift.id,
        at: "2026-08-14T18:00:00.000Z",
        group: { metric: "session", label: "push day" },
        readings: [{ metric: "working_weight", value: 80, unit: "kg" }],
      },
      ACTOR,
    );
    const dir = await tempDir();
    await appendMeasurements(dir, await toRecords(a.db, "health", written));

    // The file names the subject by ref, so it reads in a diff and survives the uuid being regenerated
    // nowhere - the plan file uses the same identity.
    expect(await readFile(join(dir, "2026-08.yaml"), "utf8")).toContain("ref: LIFT-1");

    const b = await freshDb();
    const p2 = await project(b.db, b.ownerId);
    await createItem(b.db, { projectId: p2.id, area: "LIFT", title: "Bench press" }, ACTOR);
    expect(await loadMeasurements(b.db, await readMeasurements(dir))).toEqual({ loaded: 2, skipped: 0 });

    const restored = await allMeasurements(b.db, p2.id);
    expect(restored.map((m) => m.metric)).toEqual(["session", "working_weight"]);
    // The tree survives, and so does the denormalised subject on the child.
    const [session, weight] = restored;
    expect(weight!.parentId).toBe(session!.id);
    expect(restored.every((m) => m.itemId !== null)).toBe(true);
    await a.close();
    await b.close();
  });

  it("skips a reading whose subject no longer exists rather than refusing to open the store", async () => {
    // The plan and these files are edited independently, so one historical row pointing at a deleted item
    // must not make a year of good data unreadable. The plan is the authority on what exists.
    const dir = await tempDir();
    await appendMeasurements(dir, [
      { id: "a", project: "health", metric: "kcal", value: 1, at: "2026-08-14T20:00:00.000Z", actor: ACTOR, created_at: "now" },
      { id: "b", project: "health", metric: "reps", value: 8, at: "2026-08-14T20:00:00.000Z", ref: "GONE-1", actor: ACTOR, created_at: "now" },
      { id: "c", project: "vanished", metric: "kcal", value: 2, at: "2026-08-14T20:00:00.000Z", actor: ACTOR, created_at: "now" },
    ]);

    const { db, ownerId, close } = await freshDb();
    await project(db, ownerId);
    expect(await loadMeasurements(db, await readMeasurements(dir))).toEqual({ loaded: 1, skipped: 2 });
    expect((await db.select().from(measurements)).map((m) => m.id)).toEqual(["a"]);
    await close();
  });

  it("ignores an empty month file and reads the months in order", async () => {
    const dir = await tempDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-09.yaml"), ""); // a month created and never written to
    await appendMeasurements(dir, [
      { id: "later", project: "health", metric: "kcal", value: 2, at: "2026-08-02T20:00:00.000Z", actor: ACTOR, created_at: "n" },
    ]);
    await appendMeasurements(dir, [
      { id: "earlier", project: "health", metric: "kcal", value: 1, at: "2026-07-02T20:00:00.000Z", actor: ACTOR, created_at: "n" },
    ]);
    expect((await readMeasurements(dir)).map((r) => r.id)).toEqual(["earlier", "later"]);
  });

  it("puts the files beside the plan, under .apm/", async () => {
    expect(measurementsDirFor("/tmp/x/roadmap.apm.yaml")).toBe("/tmp/x/.apm/measurements");
  });
});
