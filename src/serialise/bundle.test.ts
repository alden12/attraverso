/**
 * The export bundle (`OPS-19.3`). What these prove is that the round trip is *whole*: a plan file alone was
 * always a partial copy of a project, because measurements live in their own month files, and the failure
 * that matters is a partial copy written over a complete one.
 */
import { describe, expect, it } from "vitest";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { freshDb } from "../db/testing";
import { createProject } from "../domain/projects";
import { createItem } from "../domain/items";
import { recordMeasurements } from "../domain/measurements";
import { buildBundle, looksLikeZip, packBundle, unpackBundle } from "./bundle";
import type { MeasurementRecord } from "./measurements";
import { stringifyStore } from "./store";

const ACTOR = "test";

const reading = (at: string, value: number): MeasurementRecord => ({
  id: `m-${at}`,
  project: "health",
  metric: "weight",
  value,
  unit: "kg",
  at,
  actor: ACTOR,
  created_at: at,
});

describe("the export bundle (OPS-19.3)", () => {
  const plan = stringifyStore({ projects: [] });

  it("round-trips the plan file and its measurements", () => {
    const measurements = [reading("2026-08-30T08:00:00.000Z", 81), reading("2026-09-01T08:00:00.000Z", 80)];
    const out = unpackBundle(packBundle({ name: "health.apm.yaml", text: plan, measurements }), "unused.apm.yaml");
    expect(out.name).toBe("health.apm.yaml");
    expect(out.text).toBe(plan);
    expect(out.measurements).toEqual(measurements);
  });

  it("buckets readings by the month they happened in, not the month they were written", () => {
    // The rule `appendMeasurements` follows on disk, shared rather than reimplemented here - a backfilled
    // reading has to land in the month of `at` or a month ends up split across two files and neither one is
    // the record of it.
    const zip = packBundle({
      name: "health.apm.yaml",
      text: plan,
      measurements: [reading("2026-08-30T08:00:00.000Z", 81), reading("2026-09-01T08:00:00.000Z", 80)],
    });
    // Re-read through fflate directly, because the assertion is about the layout inside the zip rather than
    // about what `unpackBundle` chooses to surface.
    const names = Object.keys(unzipSync(zip));
    expect(names).toContain(".apm/measurements/2026-08.yaml");
    expect(names).toContain(".apm/measurements/2026-09.yaml");
  });

  it("packs the same project to the same bytes, however long apart", () => {
    // fflate is left to its default mtime rather than being handed `now`, so an unchanged project exports
    // identically twice. Nothing depends on that today; a diffable export is the habit this serialisation
    // layer is built on, and a test is what stops a later `mtime: Date.now()` quietly ending it.
    const bundle = { name: "health.apm.yaml", text: plan, measurements: [reading("2026-09-01T08:00:00.000Z", 80)] };
    expect(packBundle(bundle)).toEqual(packBundle(bundle));
  });

  it("still accepts a bare .apm.yaml, detected by content rather than by its name", () => {
    const bytes = strToU8(plan);
    expect(looksLikeZip(bytes)).toBe(false);
    const out = unpackBundle(bytes, "roadmap.apm.yaml");
    // The fallback name is the uploaded file's, so a plan file keeps the name it had rather than being
    // renamed by the server that received it.
    expect(out).toEqual({ name: "roadmap.apm.yaml", text: plan, measurements: [] });
  });

  it("refuses a zip with no plan file in it", () => {
    const zip = zipSync({ "notes.txt": strToU8("hello") });
    expect(() => unpackBundle(zip, "x.apm.yaml")).toThrow(/not a plan export/);
  });

  it("refuses a zip of a whole checkout, naming both plan files", () => {
    // `IMP-17` split this repo's plan across two files, so zipping the checkout is an easy mistake and only
    // the person knows which project they meant.
    const zip = zipSync({ "roadmap.apm.yaml": strToU8(plan), "cloud.apm.yaml": strToU8(plan) });
    expect(() => unpackBundle(zip, "x.apm.yaml")).toThrow(/2 plan files \(cloud\.apm\.yaml, roadmap\.apm\.yaml\)|2 plan files \(roadmap\.apm\.yaml, cloud\.apm\.yaml\)/);
  });

  it("ignores the shadow tree Finder puts in a zip", () => {
    // `__MACOSX/._health.apm.yaml` is a resource fork, not a plan, and would otherwise read as a second one
    // - making every bundle zipped by Finder ambiguous.
    const zip = zipSync({
      "health.apm.yaml": strToU8(plan),
      "__MACOSX/._health.apm.yaml": strToU8("resource fork"),
    });
    expect(unpackBundle(zip, "x.apm.yaml").name).toBe("health.apm.yaml");
  });

  it("names the month file that is broken, rather than a path into an anonymous array", () => {
    const zip = zipSync({
      "health.apm.yaml": strToU8(plan),
      ".apm/measurements/2026-09.yaml": strToU8("- metric: weight\n"),
    });
    expect(() => unpackBundle(zip, "x.apm.yaml")).toThrow(/\.apm\/measurements\/2026-09\.yaml is not a measurement log/);
  });
});

describe("building a bundle from the database (OPS-19.3)", () => {
  it("carries one project only, with its own readings", async () => {
    const { db, ownerId, close } = await freshDb();
    const health = await createProject(db, { key: "health", name: "Health", type: "generic", ownerId }, ACTOR);
    const other = await createProject(db, { key: "spanish", name: "Spanish", type: "learning", ownerId }, ACTOR);
    const item = await createItem(db, { projectId: health.id, area: "BODY", title: "weigh-in" }, ACTOR);
    await recordMeasurements(
      db,
      { projectId: health.id, itemId: item.id, at: "2026-09-01T08:00:00.000Z", readings: [{ metric: "weight", value: 80, unit: "kg" }] },
      ACTOR,
    );
    await recordMeasurements(
      db,
      { projectId: other.id, at: "2026-09-01T08:00:00.000Z", readings: [{ metric: "words", value: 12 }] },
      ACTOR,
    );

    const bundle = await buildBundle(db, ownerId, health);
    // Named after the key, because the database does not know what the file was called in the checkout it
    // came from - the one manual step in the round trip, and the reason it is worth stating here.
    expect(bundle.name).toBe("health.apm.yaml");
    // Scoped to one project, which is what keeps a split plan (`IMP-17`) in separate files on the way back.
    expect(bundle.text).toContain("key: health");
    expect(bundle.text).not.toContain("key: spanish");
    expect(bundle.measurements.map((r) => r.metric)).toEqual(["weight"]);
    // Written as a ref rather than a uuid, so it still resolves after the plan is rebuilt on import.
    expect(bundle.measurements[0]?.ref).toBe(item.ref);
    await close();
  });
});
