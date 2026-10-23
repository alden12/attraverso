/**
 * Recording and querying measurements (`METRIC-2`). The two properties worth proving are the ones `METRIC-1`
 * made structural: a tree costs one call, and aggregation gives the same answer whatever shape the tree is.
 */
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { freshDb } from "../db/testing";
import { events, measurements } from "../db/schema";
import { createProject } from "./projects";
import { createItem } from "./items";
import { aggregateSeries, listMeasurements, listMetrics, recordMeasurements, summariseInSql, summariseReadings, TOP_VALUES } from "./measurements";

const ACTOR = "test";
const project = (db: Awaited<ReturnType<typeof freshDb>>["db"], ownerId: string) =>
  createProject(db, { key: "health", name: "Health", type: "health", ownerId }, ACTOR);

describe("recording (METRIC-2)", () => {
  it("writes a group and its readings in one call, with the group as their parent", async () => {
    // The cheap path has to be the correct one: nesting a meal's nutrients under the meal must cost no more
    // than putting the meal's name in `label`, or nobody will ever nest anything (CTX-2's 64 out of 64).
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);

    const rows = await recordMeasurements(
      db,
      {
        projectId: p.id,
        at: "2026-08-14T08:00:00.000Z",
        group: { metric: "meal", label: "overnight oats" },
        readings: [
          { metric: "kcal", value: 420 },
          { metric: "protein_g", value: 24, unit: "g" },
        ],
      },
      ACTOR,
    );

    const [meal, kcal, protein] = rows;
    expect(rows).toHaveLength(3);
    expect(meal!.metric).toBe("meal");
    // A group has no reading of its own: it is an occurrence, not a definition, so both columns are null.
    expect([meal!.value, meal!.textValue]).toEqual([null, null]);
    expect([kcal!.parentId, protein!.parentId]).toEqual([meal!.id, meal!.id]);
    await close();
  });

  it("denormalises the subject onto children, so aggregation never walks to the root", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    const lift = await createItem(db, { projectId: p.id, area: "LIFT", title: "Bench press" }, ACTOR);

    const rows = await recordMeasurements(
      db,
      { projectId: p.id, itemId: lift.id, group: { metric: "session" }, readings: [{ metric: "working_weight", value: 80, unit: "kg" }] },
      ACTOR,
    );
    // The copy is safe only because this call writes it - nothing hand-edits it, which is the condition
    // METRIC-1 attaches to allowing stored derived state here at all.
    expect(rows.every((r) => r.itemId === lift.id)).toBe(true);
    await close();
  });

  it("refuses a reading with both a number and text, or with neither", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);

    await expect(
      recordMeasurements(db, { projectId: p.id, readings: [{ metric: "sleep", value: 7, text: "restless" }] }, ACTOR),
    ).rejects.toThrow(/one or the other/);
    // The schema's CHECK only forbids both; it cannot tell a reading that measured nothing from a group node,
    // so the "neither" case has to be refused here.
    await expect(recordMeasurements(db, { projectId: p.id, readings: [{ metric: "sleep" }] }, ACTOR)).rejects.toThrow(/no reading/);
    expect(await db.select().from(measurements)).toHaveLength(0);
    await close();
  });

  it("normalises a plain day and refuses text that is not a date", async () => {
    // `at` is optional to pass and never absent once stored, but nothing checked the *shape* of one that was
    // passed - and three things downstream assume it: the month file is a slice of the string, a from/to
    // window is a string comparison, and aggregateSeries casts `at::timestamptz`, which throws on text
    // Postgres cannot parse. One bad row would have poisoned every query on that metric.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);

    // A backfilled log naturally produces a bare day, which is a date somebody means: midnight UTC.
    const [day] = await recordMeasurements(db, { projectId: p.id, at: "2026-08-14", readings: [{ metric: "kcal", value: 1 }] }, ACTOR);
    expect(day!.at).toBe("2026-08-14T00:00:00.000Z");

    // Refused rather than handed to `Date`, which parses "14 Aug 2026" in the host's local zone and shifts it.
    for (const bad of ["yesterday", "14 Aug 2026", ""]) {
      await expect(recordMeasurements(db, { projectId: p.id, at: bad, readings: [{ metric: "kcal", value: 1 }] }, ACTOR)).rejects.toThrow(/is not a date/);
    }
    // A per-reading override goes through the same check, or the hole simply moves.
    await expect(
      recordMeasurements(db, { projectId: p.id, readings: [{ metric: "kcal", value: 1, at: "whenever" }] }, ACTOR),
    ).rejects.toThrow(/is not a date/);

    // And a normalised day still queries: the cast that would have thrown now cannot be reached with bad text.
    const series = await aggregateSeries(db, { projectId: p.id, metric: "kcal" }, { bucket: "day" });
    expect(series.points).toEqual([{ at: "2026-08-14T00:00:00.000Z", value: 1, n: 1 }]);
    await close();
  });

  it("takes a categorical reading beside a numeric one", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await recordMeasurements(
      db,
      { projectId: p.id, readings: [{ metric: "protein_g", value: 134, unit: "g" }, { metric: "sleep_quality", text: "restless" }] },
      ACTOR,
    );
    // The vocabulary of a categorical is discovered, not maintained: SELECT DISTINCT is the enum.
    const quality = await db.selectDistinct({ v: measurements.textValue }).from(measurements).where(eq(measurements.metric, "sleep_quality"));
    expect(quality.map((q) => q.v)).toEqual(["restless"]);
    await close();
  });

  it("logs one event for the whole tree, keyed on its root", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    const rows = await recordMeasurements(db, { projectId: p.id, group: { metric: "meal" }, readings: [{ metric: "kcal", value: 1 }] }, ACTOR);

    const logged = await db.select().from(events).where(eq(events.entityType, "measurement"));
    expect(logged).toHaveLength(1); // the tree is one act of recording, not three
    expect(logged[0]!.entityId).toBe(rows[0]!.id);
    await close();
  });
});

describe("querying (METRIC-2)", () => {
  it("gives the same total whether the readings were nested or flat", async () => {
    // The safety net. Aggregation filters on metric and window and never on parent_id, which is what makes
    // uncapped nesting depth safe: a badly shaped tree costs display quality, never correctness.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    const day = { from: "2026-08-14T00:00:00.000Z", to: "2026-08-14T23:59:59.999Z" };

    await recordMeasurements(
      db,
      { projectId: p.id, at: "2026-08-14T08:00:00.000Z", group: { metric: "meal", label: "oats" }, readings: [{ metric: "kcal", value: 420 }] },
      ACTOR,
    );
    await recordMeasurements(db, { projectId: p.id, at: "2026-08-14T13:00:00.000Z", readings: [{ metric: "kcal", value: 604 }] }, ACTOR);

    const series = await aggregateSeries(db, { projectId: p.id, metric: "kcal", ...day }, { bucket: "day" });
    expect(series.points).toEqual([{ at: "2026-08-14T00:00:00.000Z", value: 1024, n: 2 }]);
    await close();
  });

  it("buckets by day and window, and counts the readings behind each point", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const [at, value] of [
      ["2026-08-13T07:00:00.000Z", 78.4],
      ["2026-08-14T07:00:00.000Z", 78.1],
      ["2026-08-14T19:00:00.000Z", 78.9],
      ["2026-08-20T07:00:00.000Z", 77.6],
    ] as const) {
      await recordMeasurements(db, { projectId: p.id, at, readings: [{ metric: "body_weight", value, unit: "kg" }] }, ACTOR);
    }

    const series = await aggregateSeries(
      db,
      { projectId: p.id, metric: "body_weight", from: "2026-08-13T00:00:00.000Z", to: "2026-08-14T23:59:59.999Z" },
      { bucket: "day", aggregate: "avg" },
    );
    expect(series.points.map((point) => point.at)).toEqual(["2026-08-13T00:00:00.000Z", "2026-08-14T00:00:00.000Z"]);
    // n is what separates one weigh-in from two averaged, which a bare value cannot say.
    expect(series.points.map((point) => point.n)).toEqual([1, 2]);
    expect(series.points[1]!.value).toBeCloseTo(78.5, 5);
    await close();
  });

  it("reports every unit in the window, because a mixed series plots as a 2.2x gain", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await recordMeasurements(db, { projectId: p.id, readings: [{ metric: "body_weight", value: 78.4, unit: "kg" }] }, ACTOR);
    await recordMeasurements(db, { projectId: p.id, readings: [{ metric: "body_weight", value: 172, unit: "lb" }] }, ACTOR);

    // Surfaced at the query rather than discovered by whoever draws the chart (METRIC-4 must refuse to plot).
    const series = await aggregateSeries(db, { projectId: p.id, metric: "body_weight" }, {});
    expect(series.units.sort()).toEqual(["kg", "lb"]);
    await close();
  });

  it("counts rows for a categorical series, where summing a null column would report nothing", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const text of ["restless", "restless", "sound"]) {
      await recordMeasurements(db, { projectId: p.id, at: "2026-08-14T07:00:00.000Z", readings: [{ metric: "sleep_quality", text }] }, ACTOR);
    }
    const series = await aggregateSeries(db, { projectId: p.id, metric: "sleep_quality" }, { bucket: "day", aggregate: "count" });
    expect(series.points).toEqual([{ at: "2026-08-14T00:00:00.000Z", value: 3, n: 3 }]);
    await close();
  });

  it("reports that a categorical series carries no numbers, so an empty column is not read as no data", async () => {
    // Postgres answers sum(NULL) with NULL rather than an error, so a numeric aggregate over a categorical
    // metric comes back as a column of blanks - which reads as "nothing recorded" when it means "wrong
    // question". `numericReadings` is what lets the caller tell those apart.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const text of ["restless", "sound"]) {
      await recordMeasurements(db, { projectId: p.id, at: "2026-08-14T07:00:00.000Z", readings: [{ metric: "sleep_quality", text }] }, ACTOR);
    }

    const summed = await aggregateSeries(db, { projectId: p.id, metric: "sleep_quality" }, { aggregate: "sum" });
    expect(summed.points[0]!.value).toBeNull(); // the blank column
    expect(summed.points[0]!.n).toBe(2); // ...over two real readings
    expect(summed.numericReadings).toBe(0); // ...none of which is a number

    // Counting works, and says so: this is the aggregate a categorical series wants.
    const counted = await aggregateSeries(db, { projectId: p.id, metric: "sleep_quality" }, { aggregate: "count" });
    expect(counted.points[0]!.value).toBe(2);
    expect(counted.numericReadings).toBe(0);

    // An empty window is a different thing again, and must not be reported as the wrong question.
    const empty = await aggregateSeries(db, { projectId: p.id, metric: "sleep_quality", from: "2027-01-01T00:00:00.000Z" }, {});
    expect(empty.points).toEqual([]);
    await close();
  });

  it("narrows to project-level readings, so a subject filter of null is not the same as no filter", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    const lift = await createItem(db, { projectId: p.id, area: "LIFT", title: "Bench press" }, ACTOR);
    await recordMeasurements(db, { projectId: p.id, itemId: lift.id, readings: [{ metric: "reps", value: 8 }] }, ACTOR);
    await recordMeasurements(db, { projectId: p.id, readings: [{ metric: "reps", value: 99 }] }, ACTOR);

    expect(await listMeasurements(db, { projectId: p.id, metric: "reps" })).toHaveLength(2);
    expect((await listMeasurements(db, { projectId: p.id, metric: "reps", itemId: null })).map((m) => m.value)).toEqual([99]);
    expect((await listMeasurements(db, { projectId: p.id, metric: "reps", itemId: lift.id })).map((m) => m.value)).toEqual([8]);
    await close();
  });

  it("lists the metric vocabulary with counts and the units each uses", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await recordMeasurements(
      db,
      { projectId: p.id, group: { metric: "meal" }, readings: [{ metric: "kcal", value: 420 }, { metric: "protein_g", value: 24, unit: "g" }] },
      ACTOR,
    );
    // The group node appears too: "meal" is a metric in use, and hiding it would make the tree invisible to
    // anyone browsing what this project records.
    expect(await listMetrics(db, p.id)).toEqual([
      { metric: "kcal", count: 1, units: [] },
      { metric: "meal", count: 1, units: [] },
      { metric: "protein_g", count: 1, units: ["g"] },
    ]);
    await close();
  });
});

describe("summarising for the pane (METRIC-4)", () => {
  const at = (day: string) => `2026-08-${day}T07:00:00.000Z`;

  it("reports the latest reading, the count and the span, per subject and metric", async () => {
    // Descriptive, never interpretive: an average is right for a benchmark and wrong for a daily total, so
    // the pane reports what is true of any metric and leaves the aggregate to whoever asks for one.
    const summary = summariseReadings([
      { ref: "LIFT-1", metric: "reps", at: at("13"), value: 8, text: null, unit: null },
      { ref: "LIFT-1", metric: "reps", at: at("15"), value: 10, text: null, unit: null },
      { ref: "LIFT-1", metric: "reps", at: at("14"), value: 9, text: null, unit: null },
    ]);
    expect(summary).toEqual([
      { ref: "LIFT-1", metric: "reps", count: 3, latest: 10, latestText: null, latestAt: at("15"), firstAt: at("13"), units: [], values: [], distinctValues: 0 },
    ]);
  });

  it("keeps subjects apart, so one item's readings never become another's", async () => {
    const summary = summariseReadings([
      { ref: "LIFT-1", metric: "reps", at: at("13"), value: 8, text: null, unit: null },
      { ref: null, metric: "reps", at: at("13"), value: 99, text: null, unit: null },
    ]);
    expect(summary.map((m) => [m.ref, m.latest])).toEqual([
      [null, 99],
      ["LIFT-1", 8],
    ]);
  });

  it("carries a categorical reading and collects every unit in use", async () => {
    const summary = summariseReadings([
      { ref: null, metric: "sleep_quality", at: at("13"), value: null, text: "restless", unit: null },
      { ref: null, metric: "body_weight", at: at("13"), value: 78.4, text: null, unit: "kg" },
      { ref: null, metric: "body_weight", at: at("14"), value: 172, text: null, unit: "lb" },
    ]);
    const [weight, quality] = summary;
    // Reported rather than reconciled: the pane marks it, the same as the query layer warns.
    expect(weight!.units).toEqual(["kg", "lb"]);
    expect(quality!.latestText).toBe("restless");
    expect(quality!.latest).toBeNull();
  });

  it("summarises a categorical as its distribution, commonest first and capped", async () => {
    // The distribution is to a categorical what the latest reading is to a number: "restless" alone says
    // almost nothing about a sleep log, where "restless x3, sound x2" is the shape of it.
    const summary = summariseReadings([
      { ref: null, metric: "sleep_quality", at: at("13"), value: null, text: "sound", unit: null },
      { ref: null, metric: "sleep_quality", at: at("14"), value: null, text: "restless", unit: null },
      { ref: null, metric: "sleep_quality", at: at("15"), value: null, text: "restless", unit: null },
    ]);
    expect(summary[0]!.values).toEqual([
      { text: "restless", count: 2 },
      { text: "sound", count: 1 },
    ]);
    expect(summary[0]!.distinctValues).toBe(2);
    expect(summary[0]!.latestText).toBe("restless"); // and the latest is still there for anything that wants it
  });

  it("caps the values it carries, because a free-text categorical has no bound", async () => {
    // The whole reason a summary is safe in the feed is that its size does not follow the data's, and a
    // free-text metric would otherwise put every distinct answer on the wire.
    const summary = summariseReadings(
      Array.from({ length: 40 }, (_, i) => ({ ref: null, metric: "note", at: at("13"), value: null, text: `value ${i}`, unit: null })),
    );
    expect(summary[0]!.values).toHaveLength(TOP_VALUES);
    expect(summary[0]!.distinctValues).toBe(40); // the true total rides along, so the caller can say "+35 more"
    expect(summary[0]!.count).toBe(40);
  });

  it("leaves a numeric metric's distribution empty, so nothing renders one for it", async () => {
    const summary = summariseReadings([{ ref: null, metric: "kcal", at: at("13"), value: 420, text: null, unit: null }]);
    expect(summary[0]!.values).toEqual([]);
    expect(summary[0]!.distinctValues).toBe(0);
  });

  it("stays one row per metric however many readings there are, which is what makes it feed-safe", async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      ref: null,
      metric: "kcal",
      at: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T07:00:00.000Z`,
      value: i,
      text: null,
      unit: null,
    }));
    expect(summariseReadings(many)).toHaveLength(1);
    expect(summariseReadings(many)[0]!.count).toBe(500);
  });
});

/**
 * The two summarisers have to agree (`METRIC-6`).
 *
 * `summariseInSql` aggregates in Postgres for the hosted and loopback viewers; `summariseReadings` folds in
 * Node for the dev server, which has no database to aggregate in. That is a real reason for two
 * implementations and no reason at all for two answers, and shape drift between paths serving one route is
 * the bug this repo hit twice in the same week. So this is the guard: one dataset, both paths, compared.
 *
 * **The fixture is built to have the edges in it**, since an equality test over easy data proves that two
 * functions can both handle easy data. A project-level reading (`item_id` NULL, which an equality join drops
 * silently), a metric with mixed units, a categorical with more distinct values than `TOP_VALUES`, an
 * occurrence carrying no reading at all, and a metric with exactly one reading.
 *
 * **No two readings of one metric share a timestamp.** The fold resolves a tie by arrival order and the query
 * resolves it by id, and `SummarisableReading` has no id to compare - so a tie is the one case where they
 * cannot be made to agree, and pinning it here would be pinning an accident.
 */
describe("both summarisers give the same answer (METRIC-6)", () => {
  it("agrees over project-level readings, mixed units, a long tail and an occurrence", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    const item = await createItem(db, { projectId: p.id, area: "LIFT", title: "squat" }, ACTOR);
    const day = (d: number, h = 8): string => `2026-08-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;

    // Subject = the project, which is how a health log records a body weight. Mixed units on purpose.
    for (const [i, [value, unit]] of ([[74.2, "kg"], [73.9, "kg"], [163, "lb"]] as [number, string][]).entries()) {
      await recordMeasurements(db, { projectId: p.id, at: day(i + 1), readings: [{ metric: "body_weight", value, unit }] }, ACTOR);
    }
    // More distinct values than the cap, with an unambiguous frequency order so the cut is not a coin toss.
    const sleep = ["restless", "restless", "restless", "sound", "sound", "broken", "vivid", "hot", "cold"];
    for (const [i, text] of sleep.entries()) {
      await recordMeasurements(db, { projectId: p.id, at: day(i + 1, 22), readings: [{ metric: "sleep_quality", text }] }, ACTOR);
    }
    // An occurrence: a group with no reading of its own, whose children hang off it.
    await recordMeasurements(
      db,
      { projectId: p.id, itemId: item.id, at: day(20), group: { metric: "workout" }, readings: [{ metric: "reps", value: 5 }, { metric: "reps", value: 8 }] },
      ACTOR,
    );
    // Exactly one reading, since a series of one takes a different branch in the fold.
    await recordMeasurements(db, { projectId: p.id, itemId: item.id, at: day(21), readings: [{ metric: "one_rep_max", value: 100, unit: "kg" }] }, ACTOR);

    const inSql = await summariseInSql(db, p.id);
    // The fold's input, assembled the way the file path assembles it: refs rather than ids, oldest first.
    const rows = await db.select().from(measurements).where(eq(measurements.projectId, p.id)).orderBy(asc(measurements.at));
    const folded = summariseReadings(
      rows.map((r) => ({ ref: r.itemId === null ? null : item.ref, metric: r.metric, at: r.at, value: r.value, text: r.textValue, unit: r.unit })),
    );

    // Named before the comparison, so a failure says which edge broke rather than dumping two arrays.
    expect(inSql.map((m) => m.metric)).toEqual(["body_weight", "one_rep_max", "reps", "sleep_quality", "workout"]);
    expect(inSql.find((m) => m.metric === "body_weight")!.units).toEqual(["kg", "lb"]);
    expect(inSql.find((m) => m.metric === "sleep_quality")!.values).toHaveLength(TOP_VALUES);
    expect(inSql.find((m) => m.metric === "sleep_quality")!.distinctValues).toBe(6);
    expect(inSql.find((m) => m.metric === "workout")!.latest).toBeNull();
    expect(inSql.find((m) => m.metric === "workout")!.latestText).toBeNull();
    // The project-level rows kept their null ref rather than being dropped by an equality join on item_id.
    expect(inSql.find((m) => m.metric === "body_weight")!.ref).toBeNull();
    expect(inSql.find((m) => m.metric === "reps")!.ref).toBe(item.ref);

    expect(inSql).toEqual(folded);

    // The empty case on the same fixture rather than its own: a second `freshDb()` is a second WASM Postgres
    // out of the pool, and this asserts nothing the first project's rows are needed for.
    const quiet = await createProject(db, { key: "quiet", name: "Quiet", type: "software", ownerId }, ACTOR);
    expect(await summariseInSql(db, quiet.id)).toEqual([]);
    expect(summariseReadings([])).toEqual([]);
    await close();
  });


});
