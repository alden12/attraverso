/**
 * Areas: the ref prefix that groups items, and the metadata a project can attach to one.
 *
 * **Areas are open, and this never changes that.** The prefix on a ref *is* the area, so `create_item` with a
 * new prefix invents one on the spot and nothing may reject it. The `areas` table is therefore metadata (a
 * name, a colour, a display order) and never a constraint.
 *
 * Which forces the shape of this query: **the key list comes from `items`, not from `areas`.** Nothing writes
 * an `areas` row today - `createItem` sets `areaKey` on the item and stops - so the rows that exist came in
 * with the original YAML seed, and listing the table would silently omit every area created since. Reading
 * items and left-joining the metadata cannot go stale, because the items are what defines the set.
 *
 * Surfaced because the `PROJ-8` trim removed the thing that used to convey it. The pack once listed every open
 * item, so the area vocabulary was visible by accident; with the listing replaced by two short groups, nothing
 * told a caller that `CAL` or `SCHED` existed at all.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { areas, items } from "../db/schema";
import type { OwnedProjectId } from "./owned";

export interface AreaSummary {
  /** The ref prefix, and what `list_items(area:)` takes. */
  key: string;
  /** Its name, or null for an area with no `areas` row - which is any area created since the project's seed. */
  name: string | null;
  /** Items not done and not soft-deleted: the count that matches what a board shows. */
  open: number;
  /** Every item in it, so "8 of 24 left" is answerable without a second call. */
  total: number;
}

/**
 * Every area in the project with its open and total counts, in display order.
 *
 * Ordered by the metadata's `sort_order` where there is a row, then alphabetically for the rest. An area
 * nobody has named sorts after the ones somebody did, which is the right way round: the named ones are the
 * project's stated structure and the unnamed one is a prefix that appeared.
 */
export async function listAreas(db: Database, projectId: OwnedProjectId): Promise<AreaSummary[]> {
  const counts = await db
    .select({
      key: items.areaKey,
      // FILTER rather than a CASE sum: this is plain Postgres on both backends now, so the readable form is
      // available and there is no dialect to bridge.
      open: sql<number>`count(*) filter (where ${items.status} <> 'done')`.mapWith(Number),
      total: sql<number>`count(*)`.mapWith(Number),
    })
    .from(items)
    .where(and(eq(items.projectId, projectId), isNull(items.deletedAt)))
    .groupBy(items.areaKey);

  const meta = new Map(
    (await db.select().from(areas).where(eq(areas.projectId, projectId)).orderBy(asc(areas.sortOrder))).map((a) => [
      a.key,
      { name: a.name, sortOrder: a.sortOrder },
    ]),
  );

  const unnamed = Number.MAX_SAFE_INTEGER;
  return counts
    .map((row) => ({ key: row.key, name: meta.get(row.key)?.name ?? null, open: row.open, total: row.total }))
    .sort((a, b) => (meta.get(a.key)?.sortOrder ?? unnamed) - (meta.get(b.key)?.sortOrder ?? unnamed) || a.key.localeCompare(b.key));
}
