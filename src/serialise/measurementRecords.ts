/**
 * Measurement records: their file schema, how they group into month files, and the round trip to the database.
 * The filesystem half (appending to and reading those files) is `measurements.ts`, which is why this is its own
 * module: nothing here imports Node, so the in-process library (`DIST-6`) can carry measurements in a browser.
 */
import { parse, stringify } from "yaml";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { items, measurements, projects } from "../db/schema";
import { YAML_FORMAT } from "./format";

/**
 * One recorded reading, as it appears in the file.
 *
 * The subject is written as an **item ref** (`LIFT-1`) rather than a uuid, because a ref is readable in a diff
 * and is the identity the plan file already uses. `parent` stays a uuid: a measurement has no ref to be named
 * by, so its id is the only handle it has.
 */
const recordSchema = z.object({
  id: z.string(),
  project: z.string(), // the project key - one directory serves a store that may hold several
  metric: z.string(),
  value: z.number().optional(),
  text: z.string().optional(),
  unit: z.string().optional(),
  label: z.string().optional(),
  at: z.string(),
  source: z.string().optional(),
  /** The subject item, by ref. Absent means the subject is the project itself. */
  ref: z.string().optional(),
  parent: z.string().optional(),
  actor: z.string(),
  created_at: z.string(),
});

export type MeasurementRecord = z.infer<typeof recordSchema>;

const fileSchema = z.array(recordSchema);

/** Drop a null/empty optional so it is omitted from the YAML entirely. */
const opt = <T>(value: T | null | undefined): T | undefined => (value === null || value === undefined ? undefined : value);

/** `2026-08-14T20:00:00.000Z` becomes `2026-08`. Sliced from the string rather than parsed as a `Date`, so a
 *  value that is not a timestamp lands somewhere deterministic instead of at the epoch. `asTimestamp` makes
 *  that unreachable through the domain layer; this stays for a hand-edited file, which is the only route
 *  left, and is why it is a fallback rather than a throw - one bad row must not hide a month of good ones. */
const monthOf = (at: string): string => (/^\d{4}-\d{2}/.test(at) ? at.slice(0, 7) : "unknown");

/**
 * Records grouped into the month files they belong in, as `2026-09.yaml` -> its YAML.
 *
 * Shared by the append above and by the export bundle (`OPS-19.3`), which writes whole months into a zip
 * rather than appending to disk. The grouping is the part worth having once: bucketing by the month of `at`
 * is the rule that keeps a backfilled reading in the month it happened, and a second copy of it in the zip
 * builder is how the two destinations would come to disagree about which file a record belongs in.
 */
export function measurementFiles(rows: MeasurementRecord[]): Map<string, string> {
  const byMonth = new Map<string, MeasurementRecord[]>();
  for (const row of rows) {
    const month = monthOf(row.at);
    byMonth.set(month, [...(byMonth.get(month) ?? []), row]);
  }
  return new Map([...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, batch]) => [`${month}.yaml`, stringify(batch, YAML_FORMAT)]));
}

/** One month file's contents as records. Throws with zod's reason when the file is not a measurement log,
 *  which is what an unpacked zip needs: a bad file names itself rather than importing half a reading. */
export function parseMeasurementFile(text: string): MeasurementRecord[] {
  const parsed = parse(text);
  // An empty file parses to null: a month that was created and never written to.
  if (parsed === null || parsed === undefined) return [];
  return fileSchema.parse(parsed);
}

/**
 * Load records into the database, after the plan - items must exist for a subject ref to resolve.
 *
 * **A row whose project or subject no longer exists is skipped, not fatal.** The plan file and these files are
 * edited independently: a project can be deleted, a ref hand-rewritten. Refusing to open the store because one
 * historical reading points at nothing would make a year of good data unreadable over one bad row. The plan is
 * the authority on what exists; this is only the record of what was measured.
 *
 * Roots are inserted before children by sorting on whether `parent` is set, which is enough because a child is
 * never written before its parent and the self-reference is only ever one generation at a time.
 */
export async function loadMeasurements(tx: Tx | Database, records: MeasurementRecord[]): Promise<{ loaded: number; skipped: number }> {
  if (records.length === 0) return { loaded: 0, skipped: 0 };

  const projectRows = await tx.select({ id: projects.id, key: projects.key }).from(projects);
  const projectIdByKey = new Map(projectRows.map((p) => [p.key, p.id]));
  const itemRows = await tx.select({ id: items.id, ref: items.ref, projectId: items.projectId }).from(items);
  const itemIdByKey = new Map(itemRows.map((i) => [`${i.projectId} ${i.ref}`, i.id]));

  const ordered = [...records].sort((a, b) => Number(a.parent !== undefined) - Number(b.parent !== undefined));
  const values: (typeof measurements.$inferInsert)[] = [];
  let skipped = 0;
  for (const r of ordered) {
    const projectId = projectIdByKey.get(r.project);
    if (projectId === undefined) {
      skipped++;
      continue;
    }
    const itemId = r.ref === undefined ? null : (itemIdByKey.get(`${projectId} ${r.ref}`) ?? null);
    if (r.ref !== undefined && itemId === null) {
      skipped++;
      continue;
    }
    values.push({
      id: r.id,
      projectId,
      itemId,
      parentId: r.parent ?? null,
      metric: r.metric,
      value: r.value ?? null,
      textValue: r.text ?? null,
      unit: r.unit ?? null,
      label: r.label ?? null,
      at: r.at,
      source: r.source ?? null,
      actor: r.actor,
      createdAt: r.created_at,
    });
  }
  if (values.length > 0) await tx.insert(measurements).values(values);
  return { loaded: values.length, skipped };
}

/** Database rows as file records, for writing what was just recorded. Never used to rewrite a file: nothing
 *  re-serialises what is already in one. */
export async function toRecords(
  db: Database,
  projectKey: string,
  rows: (typeof measurements.$inferSelect)[],
): Promise<MeasurementRecord[]> {
  const itemIds = [...new Set(rows.map((r) => r.itemId).filter((id): id is string => id !== null))];
  const refById = new Map<string, string>();
  for (const id of itemIds) {
    const [row] = await db.select({ ref: items.ref }).from(items).where(eq(items.id, id));
    if (row !== undefined) refById.set(id, row.ref);
  }
  return rows.map((r) => ({
    id: r.id,
    project: projectKey,
    metric: r.metric,
    value: opt(r.value),
    text: opt(r.textValue),
    unit: opt(r.unit),
    label: opt(r.label),
    at: r.at,
    source: opt(r.source),
    ref: r.itemId === null ? undefined : refById.get(r.itemId),
    parent: opt(r.parentId),
    actor: r.actor,
    created_at: r.createdAt,
  }));
}
