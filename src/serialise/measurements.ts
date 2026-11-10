/**
 * Measurement files: the append-heavy half of the store (`METRIC-1`, `METRIC-2`).
 *
 * Everything else here is rewritten whole on every mutation, which is affordable because the plan is tens of
 * kilobytes and a change is a one-line diff. Measurements are the opposite - a daily weigh-in, a meal, every
 * set of every lift - so a year of them outweighs the plan they hang off, and inlining them would mean
 * rewriting a multi-megabyte file to record one number. `IMP-7`'s split-by-volatility rule sends them to
 * `.apm/measurements/YYYY-MM.yaml` instead, **appended rather than rewritten**.
 *
 * **A top-level YAML sequence is what makes appending legal.** Adding another `- id: ...` entry to the end of
 * a file that already holds a sequence is still one valid document, so a write costs the new rows only and
 * the diff is exactly what arrived. Nothing re-serialises what is already there, which is the whole point.
 *
 * **These files are durable data and belong in git**, unlike `.apm/events.jsonl`, which git supersedes
 * (`IMP-7`). Losing a year of weigh-ins is losing the data itself, and append-only keeps the diffs clean.
 *
 * **Bucketed by the month of `at`, not of the write.** Backfilling last month's log has to land in last
 * month's file, or a month ends up split across two and neither one is the record of it.
 */
import { mkdir, readdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { summariseReadings, type MetricSummary } from "../domain/measurements";
import { measurementFiles, parseMeasurementFile, type MeasurementRecord } from "./measurementRecords";
import { dataDirFor } from "./paths";

// The records themselves - their schema, the month grouping and the database round trip - are in
// `measurementRecords.ts`, which touches no filesystem so the in-process library can load them in a browser
// (`DIST-6`). Re-exported, so everything that imported them from here still does.
export * from "./measurementRecords";

/** Where measurements live for a plan file: `measurements/` in its data folder, beside `mediaDirFor`'s (`IMP-20`). */
export const measurementsDirFor = (storePath: string): string => join(dataDirFor(storePath), "measurements");

/**
 * Append rows to their month files.
 *
 * Grouped first, so a batch spanning two months is two appends rather than one per row and a month's whole
 * batch goes down in one write. A torn append is then at worst a partial final record, which the parse
 * rejects loudly rather than silently importing half a reading.
 */
export async function appendMeasurements(dir: string, rows: MeasurementRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await mkdir(dir, { recursive: true });
  for (const [name, text] of measurementFiles(rows)) {
    // `stringify` of an array yields `- ` sequence entries: appended to a file that already holds a sequence
    // they extend it, and appended to nothing they start one.
    await appendFile(join(dir, name), text);
  }
}

/** Every record on disk, oldest month first. A missing directory is a store that has recorded nothing. */
export async function readMeasurements(dir: string): Promise<MeasurementRecord[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".yaml")).sort();
  } catch {
    return [];
  }
  const out: MeasurementRecord[] = [];
  for (const name of names) out.push(...parseMeasurementFile(await readFile(join(dir, name), "utf8")));
  return out;
}

/**
 * Metric summaries straight from the month files, per project key - what the dev server answers `/api/store`
 * with, since `yarn viewer` has no database to query.
 *
 * **The aggregate is shared; only the reading of the files is not.** `summariseReadings` is the same function
 * the two database-backed hosts reach through `storeFeed`, so all three routes agree on what a summary is.
 * What lives here is the part that genuinely differs - opening the files - plus the mapping from a stored
 * record to a summarisable one, which is the bit worth having in exactly one place: a hand-written field map
 * sitting in a Vite config is how a field added to a measurement gets silently dropped by one route, which is
 * the drift `METRIC-4` had already hit between the other two.
 *
 * Keyed by project key rather than id, because a plan file is what the caller has and refs are how it names
 * things. A project with nothing recorded is absent rather than empty, so the viewer's `metrics[key]` check
 * stays a single test.
 */
export async function summariseFromFiles(storePath: string, projectKeys: string[]): Promise<Record<string, MetricSummary[]>> {
  const records = await readMeasurements(measurementsDirFor(storePath));
  const out: Record<string, MetricSummary[]> = {};
  for (const key of projectKeys) {
    const mine = records.filter((r) => r.project === key);
    if (mine.length === 0) continue;
    out[key] = summariseReadings(
      mine.map((r) => ({ ref: r.ref ?? null, metric: r.metric, at: r.at, value: r.value ?? null, text: r.text ?? null, unit: r.unit ?? null })),
    );
  }
  return out;
}
