/**
 * Recording and querying measurements (`METRIC-2`).
 *
 * Two rules from `METRIC-1` shape everything here, and both are structural rather than documented:
 *
 * - **Writing a tree must be as cheap as writing a label.** `recordMeasurements` takes an optional `group`
 *   plus its readings and writes them in one call, so nesting a meal's nutrients under the meal costs no more
 *   than putting the meal's name in `label`. `CTX-2` measured what happens when the cheap path is cheaper
 *   than the correct one - `add_note` was ignored 64 times out of 64 by its own description - so leaving the
 *   tree as the expensive option would guarantee it never got built.
 * - **Aggregation never traverses the tree.** Every query below filters on `metric` and a time window and
 *   nothing else, so "all calories on 14 August" is the same answer whether the rows were nested under a meal
 *   or logged flat. That is what makes uncapped depth safe to allow: a badly shaped tree costs display
 *   quality, never correctness.
 *
 * `at` is what the caller says, defaulting to now. It is *when it was measured*, which is not when it was
 * recorded - `created_at` is that - and the difference is the whole point of being able to backfill a log.
 */
import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { timestamp } from "../db/ids";
import { rowsOf } from "../db/rows";
import { measurements } from "../db/schema";
import { mutate, type Actor } from "./events";
import type { OwnedProjectId } from "./owned";

export type Measurement = typeof measurements.$inferSelect;

/**
 * A caller-supplied `at`, normalised to the fixed-width ISO-8601 UTC form everything else here stores.
 *
 * **`at` is optional to pass and never absent once stored** - it defaults to now, and the column is NOT NULL.
 * What was missing is that nothing checked the *shape* of one that was passed, and three things downstream
 * assume it: the month file is `at.slice(0, 7)`, a `from`/`to` window is a string comparison (correct only
 * because the format is fixed-width), and `aggregateSeries` casts `at::timestamptz`, which **throws** on text
 * Postgres cannot parse. So one bad row would poison every query on that metric, having been accepted
 * silently a week earlier.
 *
 * Normalised rather than refused, because backfilling a log naturally produces a bare `2026-08-14`, and that
 * is a date somebody means rather than a mistake - it becomes midnight UTC.
 *
 * Anchored on an ISO date first, so `14 Aug 2026` and `yesterday` are refused rather than handed to `Date`,
 * which would parse the first in the host's local zone and shift it by hours with nothing to show for it.
 */
export function asTimestamp(at: string): string {
  const parsed = /^\d{4}-\d{2}-\d{2}/.test(at.trim()) ? new Date(at.trim()) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`"${at}" is not a date. Give an ISO-8601 instant (2026-08-14T08:00:00Z) or a plain day (2026-08-14), in UTC.`);
  }
  return timestamp(parsed);
}

/** One reading. Exactly one of `value` or `text` - a reading with neither measures nothing, and the schema's
 *  CHECK already refuses both. A node with no reading is a `group`, which is a different thing. */
export interface Reading {
  metric: string;
  value?: number;
  text?: string;
  unit?: string;
  label?: string;
  source?: string;
  /** Overrides the call's `at` for this reading alone: sets in one workout happen at different times. */
  at?: string;
}

export interface RecordMeasurements {
  projectId: OwnedProjectId;
  /** The subject item, or null/undefined for the project itself (body weight, daily calories). */
  itemId?: string | null;
  /** When these were measured. Defaults to now; a backfilled log passes the day it is about. */
  at?: string;
  /**
   * An occurrence the readings hang under: a meal, a workout, a day. Written as a parent row with no reading
   * of its own, which is what `METRIC-1` means by an occurrence as against a definition.
   */
  group?: { metric: string; label?: string; source?: string };
  /** Nest under an existing measurement, for a tree deeper than one call builds (workout > exercise > set). */
  parentId?: string;
  readings: Reading[];
}

/**
 * Write a group and its readings in one call, returning every row created (the group first, if there was one).
 *
 * **Placement is denormalised down the tree here**, and this function is the only reason that is safe: the
 * children get the root's `item_id` because the same call that creates them knows it. `METRIC-1` allows this
 * as the same exception `due_at` is - aggregation is the hot path, and walking to a root on every read would
 * defeat it - on the condition that nothing hand-edits the copy. That condition holds only while every write
 * goes through here.
 */
export async function recordMeasurements(db: Database, input: RecordMeasurements, actor: Actor): Promise<Measurement[]> {
  if (input.readings.length === 0 && input.group === undefined) throw new Error("nothing to record: give at least one reading");
  for (const r of input.readings) {
    const hasValue = r.value !== undefined && r.value !== null;
    const hasText = r.text !== undefined && r.text !== null && r.text !== "";
    // Refused here rather than left to the CHECK, because the schema only forbids *both* - it cannot know
    // that a row with neither is a reading that measured nothing, as opposed to a legitimate group node.
    if (hasValue && hasText) throw new Error(`"${r.metric}" has both a number and a text value; a reading is one or the other`);
    if (!hasValue && !hasText) throw new Error(`"${r.metric}" has no reading: give a value, or text for a categorical one`);
  }

  const at = input.at === undefined ? timestamp() : asTimestamp(input.at);
  const itemId = input.itemId ?? null;

  return mutate(db, actor, async (tx) => {
    let parentId = input.parentId ?? null;
    const created: Measurement[] = [];

    if (input.group !== undefined) {
      const [row] = await tx
        .insert(measurements)
        .values({ projectId: input.projectId, itemId, parentId, metric: input.group.metric, label: input.group.label ?? null, source: input.group.source ?? null, at, actor })
        .returning();
      created.push(row!);
      parentId = row!.id; // the readings hang under the occurrence, not beside it
    }

    if (input.readings.length > 0) {
      const rows = await tx
        .insert(measurements)
        .values(
          input.readings.map((r) => ({
            projectId: input.projectId,
            itemId, // inherited from the root: see the note above on why this copy is safe
            parentId,
            metric: r.metric,
            value: r.value ?? null,
            textValue: r.text ?? null,
            unit: r.unit ?? null,
            label: r.label ?? null,
            source: r.source ?? null,
            at: r.at === undefined ? at : asTimestamp(r.at),
            actor,
          })),
        )
        .returning();
      created.push(...rows);
    }

    const root = created[0]!;
    return {
      result: created,
      event: { projectId: input.projectId, entityType: "measurement", entityId: root.id, kind: "recorded", after: created },
    };
  });
}

export interface MeasurementFilter {
  projectId: OwnedProjectId;
  metric?: string;
  /** `null` narrows to project-level readings; `undefined` means any subject. */
  itemId?: string | null;
  from?: string;
  to?: string;
}

const where = (filter: MeasurementFilter) =>
  and(
    eq(measurements.projectId, filter.projectId),
    filter.metric === undefined ? undefined : eq(measurements.metric, filter.metric),
    filter.itemId === null ? isNull(measurements.itemId) : filter.itemId === undefined ? undefined : eq(measurements.itemId, filter.itemId),
    filter.from === undefined ? undefined : gte(measurements.at, filter.from),
    filter.to === undefined ? undefined : lte(measurements.at, filter.to),
  );

/**
 * The raw points, newest first, capped.
 *
 * Capped rather than unbounded because `METRIC-3` and `METRIC-4` both turn on the same rule: never ship a raw
 * series where a summary will do. A caller that wants a shape wants `aggregateSeries`; this is for reading
 * back what was actually written.
 */
export async function listMeasurements(db: Database, filter: MeasurementFilter, limit = 100): Promise<Measurement[]> {
  return db.select().from(measurements).where(where(filter)).orderBy(desc(measurements.at), asc(measurements.id)).limit(limit);
}

/** The metric names in use, with how many readings each has. The vocabulary is discovered rather than
 *  maintained (`METRIC-1`), so this is what a caller lists before querying a series. */
export async function listMetrics(db: Database, projectId: OwnedProjectId): Promise<{ metric: string; count: number; units: string[] }[]> {
  const rows = await db
    .select({
      metric: measurements.metric,
      count: sql<number>`count(*)`.mapWith(Number),
      units: sql<string[]>`array_remove(array_agg(DISTINCT ${measurements.unit}), NULL)`,
    })
    .from(measurements)
    .where(eq(measurements.projectId, projectId))
    .groupBy(measurements.metric)
    .orderBy(asc(measurements.metric));
  return rows.map((r) => ({ ...r, units: r.units ?? [] }));
}

export type Bucket = "day" | "week" | "month";
export type Aggregate = "sum" | "avg" | "min" | "max" | "count";

export interface SeriesPoint {
  /** The start of the bucket, as an ISO instant so it sorts and renders like every other timestamp here. */
  at: string;
  value: number | null;
  /** Readings in the bucket, so a caller can tell one weigh-in from thirty averaged. */
  n: number;
}

export interface Series {
  points: SeriesPoint[];
  /**
   * Readings in the window that carried a *number*.
   *
   * Zero with points present means a categorical series was asked a numeric question - `sum` over
   * `sleep_quality`. Postgres answers that with NULL rather than an error, so without this the reply is a
   * column of blanks that reads as "no data" when the truth is "wrong question". The tool description already
   * says to use `count` for a categorical, and `CTX-2` is the standing evidence that a description alone does
   * not hold.
   */
  numericReadings: number;
  /**
   * Every unit that appears in the window.
   *
   * Reported because `METRIC-1` stores a unit per row on purpose, so a series can honestly hold kg and lb - a
   * 2.2x step change that plots as a dramatic gain. Surfacing it here means the hazard is visible at the
   * query, not discovered by whoever draws the chart.
   */
  units: string[];
}

/**
 * A bucketed aggregate over a window.
 *
 * **Flat by construction**: the filter is a project, a metric and a time range, and never `parent_id`. That
 * is the safety net `METRIC-1` asks for - no agent has to remember to shape a tree correctly for the numbers
 * to come out right.
 *
 * Written as raw SQL because `date_trunc` on a text timestamp needs a cast and a `GROUP BY` over the result,
 * which no query builder expresses. The ticket flagged this as the query most likely to drift dialect-
 * specific; since the storage pivot both backends are Postgres, so there is one dialect and the concern is
 * retired rather than managed.
 */
export async function aggregateSeries(
  db: Database,
  filter: MeasurementFilter & { metric: string },
  options: { bucket?: Bucket; aggregate?: Aggregate } = {},
): Promise<Series> {
  const bucket: Bucket = options.bucket ?? "day";
  const aggregate: Aggregate = options.aggregate ?? "sum";
  // Both come from closed unions and are checked again here, because they are the only two values in this
  // query that reach SQL as identifiers rather than as parameters.
  if (!["day", "week", "month"].includes(bucket)) throw new Error(`unknown bucket "${bucket}"`);
  if (!["sum", "avg", "min", "max", "count"].includes(aggregate)) throw new Error(`unknown aggregate "${aggregate}"`);
  // `count` counts rows, so it must not be handed `value` - a categorical series has none, and counting a
  // null column would report zero readings where there were plenty.
  const expression = aggregate === "count" ? sql`count(*)::double precision` : sql.raw(`${aggregate}(value)`);

  const result = await db.execute(sql`
    SELECT to_char(date_trunc(${bucket}, at::timestamptz) AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
           ${expression} AS value,
           count(*)::int AS n,
           count(value)::int AS numeric_n
      FROM measurements
     WHERE project_id = ${filter.projectId}
       AND metric = ${filter.metric}
       ${filter.itemId === null ? sql`AND item_id IS NULL` : filter.itemId === undefined ? sql`` : sql`AND item_id = ${filter.itemId}`}
       ${filter.from === undefined ? sql`` : sql`AND at >= ${filter.from}`}
       ${filter.to === undefined ? sql`` : sql`AND at <= ${filter.to}`}
     GROUP BY 1
     ORDER BY 1
  `);

  const rows = rowsOf<{ at: string; value: number | string | null; n: number; numeric_n: number }>(result);
  const points = rows.map((row) => ({
    at: row.at,
    value: row.value === null ? null : Number(row.value),
    n: Number(row.n),
  }));
  const numericReadings = rows.reduce((total, row) => total + Number(row.numeric_n), 0);

  const units = await db
    .selectDistinct({ unit: measurements.unit })
    .from(measurements)
    .where(where(filter));
  return { points, numericReadings, units: units.map((u) => u.unit).filter((u): u is string => u !== null) };
}

/**
 * One line of the metrics panel: what an item measures, summarised (`METRIC-4`, MVP slice).
 *
 * **Descriptive, never interpretive**, because how a metric should be read depends on what it is. An average
 * is right for a benchmark and misleading for a cumulative total; a latest value is right for a body weight
 * and meaningless for one set of a lift. So this reports the *latest* reading, how many there are and the
 * span they cover, and leaves interpretation to whoever asked - `query_measurements` is one call away with an
 * aggregate the caller picks.
 */
export interface MetricSummary {
  /** The subject item's ref, or null for a reading about the project itself. */
  ref: string | null;
  metric: string;
  count: number;
  /** The most recent reading: a number, or the categorical text, whichever the row carried. */
  latest: number | null;
  latestText: string | null;
  latestAt: string;
  firstAt: string;
  /** Units in use. More than one means the readings are not directly comparable (`METRIC-1`). */
  units: string[];
  /**
   * For a categorical metric, its values and how often each occurred, commonest first.
   *
   * **The distribution is to a categorical what the latest reading is to a number.** "restless" on its own
   * answers almost nothing about a sleep log; "restless x8, sound x3" is the shape of it. `METRIC-1` already
   * says the vocabulary of a categorical is `SELECT DISTINCT` rather than a maintained enum, so this is that
   * rule surfaced rather than a new idea.
   *
   * Capped at `TOP_VALUES` with `distinctValues` carrying the true total, because a free-text categorical has
   * no bound and the whole reason a summary is safe in the feed is that its size does not follow the data's.
   */
  values: { text: string; count: number }[];
  distinctValues: number;
}

/** How many of a categorical's values a summary carries. Enough to see a shape, few enough to stay bounded. */
export const TOP_VALUES = 5;

/** The least a row needs to be summarised, so database rows and file records can both be fed in. */
export interface SummarisableReading {
  ref: string | null;
  metric: string;
  at: string;
  value: number | null;
  text: string | null;
  unit: string | null;
}

/**
 * Summarise readings per (subject, metric).
 *
 * **A pure function rather than a `GROUP BY`, deliberately.** The viewer is served by two paths - the MCP
 * server, which has a database, and `yarn viewer`, which parses the YAML with no database at all - and they
 * must not disagree about what a summary is. A SQL version would have to be reimplemented for the dev server,
 * and two implementations of one aggregate is precisely the drift this project keeps designing against.
 *
 * The cost is holding the readings in memory to fold them, which is nothing at the scale that matters here
 * and stops being nothing somewhere north of a hundred thousand rows. At that point the *server* path can
 * take a `GROUP BY` and this stays as the dev server's, with a shared test asserting they agree.
 *
 * **Bounded output is the property that matters**: one row per (subject, metric), however long the series
 * gets. That is what makes it safe to ship in the store feed, where `METRIC-4` rightly refuses raw points.
 */
/**
 * The order a summary is presented in, and the order a distribution is presented in.
 *
 * Shared by both implementations rather than written twice, because "sorted the same way" is the part of
 * agreeing that is easiest to lose and hardest to see. Sorting happens in the application even for the SQL
 * path: `ORDER BY` uses the database's collation and `localeCompare` uses the runtime's, and the two are
 * near enough alike to pass every test and differ on somebody's data.
 */
const bySubject = (a: { metric: string; ref: string | null }, b: { metric: string; ref: string | null }): number =>
  a.metric.localeCompare(b.metric) || (a.ref ?? "").localeCompare(b.ref ?? "");

/** Commonest first, then alphabetical, so the same data always renders in the same order. */
const byFrequency = (a: { text: string; count: number }, b: { text: string; count: number }): number =>
  b.count - a.count || a.text.localeCompare(b.text);

export function summariseReadings(readings: SummarisableReading[]): MetricSummary[] {
  const byKey = new Map<string, MetricSummary>();
  // Counted separately from the summary rows, so the cap is applied once at the end rather than fighting the
  // fold: the commonest value is only knowable after every reading has been seen.
  const tally = new Map<string, Map<string, number>>();
  for (const r of readings) {
    const key = `${r.ref ?? ""}\u0000${r.metric}`;
    const seen = byKey.get(key);
    if (seen === undefined) {
      byKey.set(key, {
        ref: r.ref,
        metric: r.metric,
        count: 1,
        latest: r.value,
        latestText: r.text,
        latestAt: r.at,
        firstAt: r.at,
        units: r.unit === null ? [] : [r.unit],
        values: [],
        distinctValues: 0,
      });
      tally.set(key, new Map(r.text === null ? [] : [[r.text, 1]]));
      continue;
    }
    seen.count++;
    if (r.at < seen.firstAt) seen.firstAt = r.at;
    // `>=` so that ties resolve to the later-seen row, matching the insertion order both callers pass in.
    if (r.at >= seen.latestAt) {
      seen.latestAt = r.at;
      seen.latest = r.value;
      seen.latestText = r.text;
    }
    if (r.unit !== null && !seen.units.includes(r.unit)) seen.units.push(r.unit);
    if (r.text !== null) {
      const counts = tally.get(key)!;
      counts.set(r.text, (counts.get(r.text) ?? 0) + 1);
    }
  }
  return [...byKey.values()]
    .map((m) => {
      const counts = [...(tally.get(`${m.ref ?? ""}\u0000${m.metric}`) ?? new Map<string, number>())]
        .map(([text, count]) => ({ text, count }))
        .sort(byFrequency);
      return { ...m, units: [...m.units].sort(), values: counts.slice(0, TOP_VALUES), distinctValues: counts.length };
    })
    .sort(bySubject);
}

/**
 * Every metric summary for a project, aggregated **in Postgres** (`METRIC-6`).
 *
 * This replaced a `SELECT` of every reading followed by `summariseReadings` in Node. The fold was never the
 * cost - the note on the query it replaced had already measured that *"the fold itself is trivial and the row
 * marshalling is not"* - and the hosted server pays that marshalling across a network from its database onto a
 * small shared-CPU machine, on a page-load path, growing with total history. Aggregating here takes rows over the
 * wire from O(readings) to O(metrics): a table of tens, however many years get logged.
 *
 * **`summariseReadings` is still the implementation for the file path**, which serves a dev server that has no
 * database. Two implementations of one answer is the drift this repo has hit twice in a week, so they are
 * pinned by a test that runs both over one fixture and compares, not by care.
 *
 * **`IS NOT DISTINCT FROM`, not `=`, on `item_id`.** A reading about the project itself has `item_id` NULL,
 * and an equality join drops every one of them silently, because `NULL = NULL` is not true. Those are exactly
 * the readings a health log records, so the bug would read as "the feature works, but that project has no
 * metrics".
 *
 * **Ordering is done in the application**, by the same comparators the fold uses: `ORDER BY` collates in the
 * database and `localeCompare` in the runtime, and two orderings that are nearly the same are worse than two
 * that are obviously different. SQL orders only where it must - to take the top values before they are
 * counted - so a tie in frequency exactly at the cut can pick a different value from the fold's.
 */
export async function summariseInSql(db: Database, projectId: OwnedProjectId): Promise<MetricSummary[]> {
  const result = await db.execute(sql`
    WITH readings AS (
      SELECT item_id, metric, value, text_value, unit, at, id FROM measurements WHERE project_id = ${projectId}
    ), grouped AS (
      SELECT item_id, metric,
             count(*)::int AS count,
             min(at) AS first_at,
             max(at) AS latest_at,
             -- at is fixed-width ISO text, so min/max order chronologically without a cast (see the timestamp helper).
             array_remove(array_agg(DISTINCT unit), NULL) AS units,
             count(DISTINCT text_value)::int AS distinct_values
        FROM readings GROUP BY item_id, metric
    ), latest AS (
      SELECT DISTINCT ON (item_id, metric) item_id, metric, value, text_value
        FROM readings
       -- id breaks a tie on at, since two readings can share a timestamp and one of them has to win.
       ORDER BY item_id, metric, at DESC, id DESC
    ), counted AS (
      SELECT item_id, metric, text_value, count(*)::int AS n,
             row_number() OVER (PARTITION BY item_id, metric ORDER BY count(*) DESC, text_value) AS rank
        FROM readings WHERE text_value IS NOT NULL GROUP BY item_id, metric, text_value
    ), top AS (
      SELECT item_id, metric, json_agg(json_build_object('text', text_value, 'count', n) ORDER BY rank) AS values
        FROM counted WHERE rank <= ${TOP_VALUES} GROUP BY item_id, metric
    )
    SELECT i.ref, g.metric, g.count, g.first_at, g.latest_at, g.units, g.distinct_values,
           l.value, l.text_value, coalesce(t.values, '[]'::json) AS values
      FROM grouped g
      LEFT JOIN items i ON i.id = g.item_id
      LEFT JOIN latest l ON l.item_id IS NOT DISTINCT FROM g.item_id AND l.metric = g.metric
      LEFT JOIN top t ON t.item_id IS NOT DISTINCT FROM g.item_id AND t.metric = g.metric
  `);

  type Row = {
    ref: string | null;
    metric: string;
    count: number;
    first_at: string;
    latest_at: string;
    units: string[] | null;
    distinct_values: number;
    value: number | string | null;
    text_value: string | null;
    values: { text: string; count: number | string }[];
  };
  return rowsOf<Row>(result)
    .map((row) => ({
      ref: row.ref,
      metric: row.metric,
      count: Number(row.count),
      // `double precision` reaches node-postgres as a string and PGlite as a number, which is the seam
      // `rowsOf` exists to name rather than to hide.
      latest: row.value === null ? null : Number(row.value),
      latestText: row.text_value,
      latestAt: row.latest_at,
      firstAt: row.first_at,
      units: [...(row.units ?? [])].sort(),
      values: (row.values ?? []).map((v) => ({ text: v.text, count: Number(v.count) })).sort(byFrequency),
      distinctValues: Number(row.distinct_values),
    }))
    .sort(bySubject);
}

/** Every measurement in a project, oldest first - the shape the file writer wants after a rebuild. */
export async function allMeasurements(tx: Tx | Database, projectId: OwnedProjectId): Promise<Measurement[]> {
  return tx.select().from(measurements).where(eq(measurements.projectId, projectId)).orderBy(asc(measurements.at), asc(measurements.id));
}
