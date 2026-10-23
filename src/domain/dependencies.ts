/**
 * The dependency graph (MCP-16, MCP-17): the edges between items, and the two integrity rules that make
 * letting an agent write them safe.
 *
 * Until this module existed, edges could only arrive through the YAML importer - which meant they came from a
 * markdown file a human had already kept acyclic. Once a tool can add one, the first mistaken pair makes the
 * graph unrenderable, and the failure surfaces in the viewer rather than at the call that caused it. So both
 * checks live on the write path, and both name what was wrong rather than only refusing.
 *
 * The edge direction is `item depends on dependsOn`: the dependency must be done first.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database, Tx } from "../db/client";
import { timestamp } from "../db/ids";
import { rowsOf } from "../db/rows";
import { dependencies, items, projects, scopedDependencies } from "../db/schema";
import { isNestedUnder, splitScope } from "../../scripts/tickets";
import type { OwnedProjectId } from "./owned";

/**
 * The refs an item depends on, ordered stably (area then sort_path) so a reply and an export never disagree.
 *
 * Scoped refs (`PROJ-11`) come last, ordered by project then ref. They cannot be interleaved by sort path,
 * because the point of one is that the item it names may not be loaded to have a sort path - and a listing
 * whose order depended on which other store file happened to be open would not be deterministic.
 */
export async function dependencyRefs(tx: Tx, itemId: string): Promise<string[]> {
  const rows = await tx
    .select({ ref: items.ref })
    .from(dependencies)
    .innerJoin(items, eq(dependencies.dependsOnId, items.id))
    .where(eq(dependencies.itemId, itemId))
    .orderBy(asc(items.areaKey), asc(items.sortPath));
  const scoped = await tx
    .select({ project: scopedDependencies.targetProject, ref: scopedDependencies.targetRef })
    .from(scopedDependencies)
    .where(eq(scopedDependencies.itemId, itemId))
    .orderBy(asc(scopedDependencies.targetProject), asc(scopedDependencies.targetRef));
  return [...rows.map((row) => row.ref), ...scoped.map(scopedRef)];
}

/** A scoped dependency as it is written and read: `apm:DIST-1`. */
export const scopedRef = (target: { project: string; ref: string }): string => `${target.project}:${target.ref}`;

/**
 * Every item's dependency refs in one query, keyed by item id.
 *
 * `dependencyRefs` above answers for one item, which is right when a caller is looking at one. Listing a whole
 * project through it would be a query per ticket - 152 of them here - so this exists for the board case, where
 * the dependency edges *are* the thing being drawn (`MCP-26`).
 *
 * Items with no dependencies are simply absent from the map rather than present with an empty array; callers
 * default with `?? []`, which is the same shape the store exporter already uses.
 */
export async function dependencyRefsByItem(db: Database, projectId: OwnedProjectId): Promise<Map<string, string[]>> {
  const dependent = alias(items, "dependent");
  const rows = await db
    .select({ itemId: dependencies.itemId, ref: items.ref })
    .from(dependencies)
    .innerJoin(items, eq(dependencies.dependsOnId, items.id))
    .innerJoin(dependent, eq(dependencies.itemId, dependent.id))
    .where(eq(dependent.projectId, projectId))
    .orderBy(asc(items.areaKey), asc(items.sortPath));

  const scoped = await db
    .select({ itemId: scopedDependencies.itemId, project: scopedDependencies.targetProject, ref: scopedDependencies.targetRef })
    .from(scopedDependencies)
    .innerJoin(dependent, eq(scopedDependencies.itemId, dependent.id))
    .where(eq(dependent.projectId, projectId))
    .orderBy(asc(scopedDependencies.targetProject), asc(scopedDependencies.targetRef));

  const byItem = new Map<string, string[]>();
  for (const row of rows) byItem.set(row.itemId, [...(byItem.get(row.itemId) ?? []), row.ref]);
  // Appended after the local ones, matching `dependencyRefs`: the two must not disagree about order, or a
  // board and a detail pane would list one item's dependencies differently.
  for (const row of scoped) byItem.set(row.itemId, [...(byItem.get(row.itemId) ?? []), scopedRef(row)]);
  return byItem;
}

/**
 * Replace an item's whole dependency set.
 *
 * Declarative rather than add/remove, deliberately: an agent that can only append cannot correct its own
 * mistake, and replacing is how the same edit would be written by hand in the YAML. Passing `[]` clears them.
 */
export async function setDependencies(
  tx: Tx,
  // A row, not a checked reference. `DATA-16` brands the ids that *enter* the domain layer, because those are
  // what a caller can get wrong; this one arrives from an insert or a select the caller already reached
  // through a scoped path, so demanding a brand here would only produce a cast - and a cast is the thing that
  // erodes the guarantee it was meant to provide.
  item: { id: string; ref: string; projectId: string },
  depRefs: string[],
): Promise<string[]> {
  const asked = [...new Set(depRefs)];

  // The item's own project, needed to tell "another project" from this one written the long way.
  const self = (await tx.select({ key: projects.key, ownerId: projects.ownerId }).from(projects).where(eq(projects.id, item.projectId)))[0];

  // A scope naming this project is normalised away rather than stored, so a within-project edge has exactly
  // one representation and `dependencies` stays the whole of the graph cycles and blocking run over.
  const scoped: { project: string; ref: string }[] = [];
  const local: string[] = [];
  for (const ref of asked) {
    const split = splitScope(ref);
    if (split === null) local.push(ref);
    else if (split.project === self?.key) local.push(split.ref);
    else scoped.push(split);
  }
  const wanted = [...new Set(local)];

  const targets =
    wanted.length === 0
      ? []
      : await tx
          .select({ id: items.id, ref: items.ref })
          .from(items)
          .where(and(eq(items.projectId, item.projectId), inArray(items.ref, wanted)));

  const found = new Map(targets.map((t) => [t.ref, t.id]));
  const missing = wanted.filter((ref) => !found.has(ref));
  if (missing.length > 0) throw new Error(`no ticket ${missing.map((r) => `"${r}"`).join(", ")} in this project`);

  for (const ref of wanted) {
    if (ref === item.ref) throw new Error(`${item.ref} cannot depend on itself`);
    // Nesting already expresses "part of", and the viewer deliberately declines to draw an edge between a
    // ticket and its own ancestor. Storing one would store something nothing will ever render.
    if (isNestedUnder(ref, item.ref) || isNestedUnder(item.ref, ref)) {
      throw new Error(`${item.ref} and ${ref} are already related by nesting, so a dependency between them would never be drawn`);
    }
  }

  // A scoped ref is checked only against a project that is actually here. Unresolved is **valid**: a clone of
  // the public repo has one store file by construction, and a check that refused there would refuse for
  // everyone who is not the author. A project that *is* loaded and lacks the ref is still an error, because
  // that is the case that means somebody deleted something.
  for (const target of scoped) {
    if (self === undefined) break;
    const other = (
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.ownerId, self.ownerId), eq(projects.key, target.project)))
    )[0];
    if (other === undefined) continue;
    const there = (
      await tx.select({ id: items.id }).from(items).where(and(eq(items.projectId, other.id), eq(items.ref, target.ref)))
    )[0];
    if (there === undefined) {
      throw new Error(`no item "${target.ref}" in project "${target.project}", which is loaded - so the ref is wrong, not merely unresolvable`);
    }
  }

  const now = timestamp();
  await tx.delete(dependencies).where(eq(dependencies.itemId, item.id));
  if (wanted.length > 0) {
    await tx.insert(dependencies).values(wanted.map((ref) => ({ itemId: item.id, dependsOnId: found.get(ref)!, createdAt: now })));
  }
  await tx.delete(scopedDependencies).where(eq(scopedDependencies.itemId, item.id));
  if (scoped.length > 0) {
    await tx
      .insert(scopedDependencies)
      .values(scoped.map((target) => ({ itemId: item.id, targetProject: target.project, targetRef: target.ref, createdAt: now })));
  }

  // Checked after the write, so one query covers every new edge at once and a failure rolls the transaction
  // back. Any cycle this call could have created must pass through `item`, because its outgoing edges are the
  // only ones that changed - which is what makes a single check from here sufficient.
  //
  // Scoped edges are deliberately outside it: the walk cannot see into a project that is not loaded, so it
  // would be sound only sometimes, which is worse than not claiming it at all (`PROJ-11`).
  const cycle = await findCycleThrough(tx, item.id);
  if (cycle !== null) throw new Error(`that would create a dependency cycle: ${cycle.join(" -> ")}`);

  // Read back rather than returning the input, so the event log's `after` is in the same canonical order as
  // its `before` (which comes from `dependencyRefs`) and a deps edit does not diff as a reordering.
  return dependencyRefs(tx, item.id);
}

/**
 * The path of a dependency cycle running through `startId`, or null if there is none.
 *
 * `WITH RECURSIVE` because this is transitive reachability, which no query builder expresses - one of the
 * cases the storage notes reserve for raw SQL through Drizzle's `sql` tag.
 *
 * The `<> ALL(path)` guard is what makes it terminate: a node already on the path is not walked again. The
 * `OR = start` beside it is the exception that makes it *work*, since closing the loop means arriving back at
 * a node that is by definition already on the path. Without the guard this runs forever on any cycle; without
 * the exception it can never find one.
 */
async function findCycleThrough(tx: Tx, startId: string): Promise<string[] | null> {
  const result = await tx.execute(sql`
    WITH RECURSIVE walk(id, path) AS (
      SELECT depends_on_id, ARRAY[item_id, depends_on_id]
        FROM dependencies
       WHERE item_id = ${startId}
      UNION ALL
      SELECT d.depends_on_id, w.path || d.depends_on_id
        FROM dependencies d
        JOIN walk w ON d.item_id = w.id
       WHERE d.depends_on_id <> ALL(w.path) OR d.depends_on_id = ${startId}
    )
    SELECT path FROM walk WHERE id = ${startId} LIMIT 1
  `);

  const row = rowsOf<{ path: string[] }>(result)[0];
  if (row === undefined) return null;

  // Report refs, not uuids: "MCP-3 -> MCP-7 -> MCP-3" tells the caller which edge to drop, and a bare refusal
  // makes them guess when several were set in one call.
  const path = row.path;
  const named = await tx.select({ id: items.id, ref: items.ref }).from(items).where(inArray(items.id, [...new Set(path)]));
  const refOf = new Map(named.map((n) => [n.id, n.ref]));
  return path.map((id) => refOf.get(id) ?? id);
}


