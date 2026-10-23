/**
 * What `/api/store` answers with, built once for every route that serves it.
 *
 * **Two routes serve this path** - the loopback host (`VIEW-12`) and the hosted server (`VIEW-24`) - and they
 * drifted the first time something was added to it: metric summaries went into the loopback one and not the
 * hosted one, so the panel worked locally and the hosted viewer showed nothing. No test could have caught it,
 * because each route is tested against itself and both were self-consistent.
 *
 * So the body is assembled here rather than at each call site. A field added to the feed now reaches both by
 * construction, which is the only guard that does not depend on somebody remembering.
 *
 * The dev server (`roadmap/vite.config.ts`) is a third answer to this path and deliberately cannot share
 * this: it has no database and reads the YAML directly. It stays in step by sharing `summariseReadings`
 * instead, which is the part with judgement in it. `VIEW-20` is where these converge properly.
 */
import type { Store } from "../serialise/store";
import { listProjects } from "../domain/projects";
import { summariseInSql, type MetricSummary } from "../domain/measurements";
import type { Database } from "../db/client";

export interface StoreFeed {
  /** The plan file being served, or null when a database is the source of truth and there is no file. */
  path: string | null;
  store: Store;
  /** Metric summaries per project key. Beside `store`, never inside it: `store` is the YAML shape, and
   *  measurements are deliberately not in the plan file (`METRIC-1`). */
  metrics: Record<string, MetricSummary[]>;
  /** Why uploads are refused, or null when they work (`OPS-11`). */
  uploadsDisabled: string | null;
}

/** Assemble the feed. `store` is passed in already projected, because the two callers reach `asPlan` by
 *  different routes and only one of them has a path to name. */
export async function storeFeed(
  db: Database,
  ownerId: string,
  parts: { store: Store; path: string | null; uploadsDisabled: string | null },
): Promise<StoreFeed> {
  return { ...parts, metrics: await metricsForFeed(db, ownerId) };
}

/**
 * Summaries for every project this owner has, keyed by project key.
 *
 * One query per project and nothing per reading (`METRIC-6`). It used to fetch every reading and fold it here,
 * plus a full item listing to turn ids into refs; the aggregate does both in the database now, so what comes
 * back is already the table the panel draws.
 */
async function metricsForFeed(db: Database, ownerId: string): Promise<Record<string, MetricSummary[]>> {
  const out: Record<string, MetricSummary[]> = {};
  for (const project of await listProjects(db, ownerId)) {
    const summaries = await summariseInSql(db, project.id);
    // Absent rather than empty, so the viewer's `metrics[key]` check stays a single test.
    if (summaries.length > 0) out[project.key] = summaries;
  }
  return out;
}
