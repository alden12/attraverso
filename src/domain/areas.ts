/**
 * Areas: the ref prefix that groups items, and the metadata a project can attach to one.
 *
 * **Areas are open, and this never changes that.** The prefix on a ref *is* the area, so `create_item` with a
 * new prefix invents one on the spot and nothing may reject it. The `areas` table is therefore metadata (a
 * name, a colour, a display order) and never a constraint.
 *
 * Which forces the shape of this query: **the key list comes from `items`, not from `areas`.** `createItem` sets
 * `areaKey` on the item and stops, and a row is only written when somebody names the area (`setArea`, `PROJ-3`),
 * so listing the table would omit every area nobody has named. Reading items and left-joining the metadata cannot
 * go stale, because the items are what defines the set.
 *
 * Surfaced because the `PROJ-8` trim removed the thing that used to convey it. The pack once listed every open
 * item, so the area vocabulary was visible by accident; with the listing replaced by two short groups, nothing
 * told a caller that `CAL` or `SCHED` existed at all.
 */
import { and, asc, eq, isNull, max, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { areas, items } from "../db/schema";
import { maybeOne, one } from "../db/rows";
import { mutate, type Actor } from "./events";
import type { OwnedProjectId } from "./owned";

export interface AreaSummary {
  /** The ref prefix, and what `list_items(area:)` takes. */
  key: string;
  /** Its name, or null for an area with no `areas` row - which is any area nobody has named (`setArea`). */
  name: string | null;
  /** What it is for, in a sentence or two, or null where nobody has said. */
  description: string | null;
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
      { name: a.name, description: a.description, sortOrder: a.sortOrder },
    ]),
  );

  const unnamed = Number.MAX_SAFE_INTEGER;
  return counts
    .map((row) => ({ key: row.key, name: meta.get(row.key)?.name ?? null, description: meta.get(row.key)?.description ?? null, open: row.open, total: row.total }))
    .sort((a, b) => (meta.get(a.key)?.sortOrder ?? unnamed) - (meta.get(b.key)?.sortOrder ?? unnamed) || a.key.localeCompare(b.key));
}

/**
 * The longest description an area takes. An area's description is what the viewer shows over it when zoomed out
 * (`VIEW-52`) and beside it in the pane, so it is a line or two about what the area holds; anything longer is a
 * context section's job, and the refusal says so, since a cap without a destination loses the content (`CTX-2`).
 */
export const MAX_AREA_DESCRIPTION = 400;

/** An area key as a ref prefix is written: letters first, then letters and digits, upper case. */
const AREA_KEY = /^[A-Z][A-Z0-9]*$/;

export interface AreaMeta {
  key: string;
  name: string;
  description: string | null;
}

/**
 * Name an area, or describe it, or both (`PROJ-3`): the write path the `areas` table never had.
 *
 * **Written on demand, never by filing an item.** An area exists the moment an item uses its prefix, as it always
 * has; a row only says what that prefix is called. So the first `setArea` creates it, at the end of the display
 * order, and later ones change it. A row whose area has no items any more stays: it is a name, not a constraint,
 * and keeping it means the name comes back with the area rather than being lost with its last item.
 *
 * Omitting a field leaves it as it was; `description: null` clears it. A first call with no name takes the key,
 * since the table needs one and the key is what the area was called until now.
 */
export async function setArea(
  db: Database,
  projectId: OwnedProjectId,
  input: { key: string; name?: string; description?: string | null },
  actor: Actor,
): Promise<AreaMeta> {
  const key = input.key.trim().toUpperCase();
  if (!AREA_KEY.test(key)) throw new Error(`"${input.key}" is not an area key: letters then letters and digits, like VIEW or OPS2`);
  const name = input.name?.trim();
  if (name === "") throw new Error("an area's name cannot be empty; omit `name` to leave it as it is");
  const description = input.description === undefined ? undefined : input.description === null ? null : input.description.trim() || null;
  if (description !== undefined && description !== null && description.length > MAX_AREA_DESCRIPTION) {
    throw new Error(
      `an area's description is at most ${MAX_AREA_DESCRIPTION} characters (this is ${description.length}): it is a line or two shown over ` +
        "the area. Put the longer account in a context section with set_context, and point to it here.",
    );
  }

  return mutate(db, actor, async (tx) => {
    const before = maybeOne(await tx.select().from(areas).where(and(eq(areas.projectId, projectId), eq(areas.key, key))));
    const after =
      before === null
        ? one(
            await tx
              .insert(areas)
              .values({
                projectId,
                key,
                name: name ?? key,
                description: description ?? null,
                // After every existing row, so naming an area does not reorder the ones already named.
                sortOrder: ((await tx.select({ last: max(areas.sortOrder) }).from(areas).where(eq(areas.projectId, projectId)))[0]?.last ?? -1) + 1,
              })
              .returning(),
          )
        : one(
            await tx
              .update(areas)
              .set({ ...(name !== undefined && { name }), ...(description !== undefined && { description }) })
              .where(eq(areas.id, before.id))
              .returning(),
          );
    return {
      result: { key: after.key, name: after.name, description: after.description },
      event: { projectId, entityType: "area", entityId: after.id, kind: before === null ? "created" : "edited", before, after },
    };
  });
}
