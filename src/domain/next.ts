/**
 * The order we agreed to work in (`PROJ-8`).
 *
 * Sessions here repeatedly end on a sequence - "search first, then trim the pack, then Hono" - and until this
 * existed that agreement was written down nowhere, so the next session re-derived it or quietly picked
 * something else. None of the fields already present is this: `dependencies` is a hard constraint rather than
 * a preference (sequencing with it would put untrue edges in the graph, and the graph is the product),
 * `priority` is a global integer that cannot be maintained across 157 items, and `status` says "committed or
 * not" without saying in what order.
 *
 * **Short by construction is the feature.** Five to ten refs forces "does this beat what is already at
 * position three?", and that forced comparison is what produces an ordering at all.
 *
 * Two rules here are worth stating because neither is obvious:
 *
 * - **Done and soft-deleted items are filtered on read, never removed on write.** Mutating stored state when
 *   a status changes is the stored-derived-state hazard this model refuses everywhere else, and it keeps the
 *   row recoverable if an item is undeleted.
 * - **An item whose dependencies are unmet is flagged, not rejected.** Wanting to do something before it is
 *   unblocked is a real intention, and often the reason to go unblock the dependency. Refusing would make the
 *   list lie about what was agreed.
 */
import { and, asc, eq, inArray, isNull, ne, notInArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database, Tx } from "../db/client";
import { dependencies, items, projectNext } from "../db/schema";
import { mutate, type Actor } from "./events";
import type { OwnedProjectId } from "./owned";

/**
 * Statuses that mean an item is no longer work anyone can pick up, so it drops out of the agreed order.
 *
 * `done` is obvious. **`review` is here because it means the work has left your hands** - the convention is
 * that an item moves to `review` when its pull request goes up, at which point it is waiting on a reviewer
 * rather than sitting in anybody's queue. Leaving it at position one is the list reporting finished work as
 * the thing to do next.
 *
 * Named rather than written as two statuses in a `where` clause, because the property is *not actionable*,
 * and whoever next asks "should X be in here?" should be answering that question rather than pattern-matching
 * a pair of strings.
 *
 * **Safe precisely because the filter is on read.** A rejected pull request moves the item back and it
 * reappears at the position it always had - the same reversibility that makes hiding `done` safe, and it
 * matters more here, because review reverses routinely where done rarely does.
 *
 * Deliberately *not* applied to blockers below: a dependency in review is not merged, so it is still in the
 * way. "Cannot be picked up" and "no longer blocks" are different questions.
 */
export const NOT_ACTIONABLE = ["done", "review"];

export interface NextItem {
  ref: string;
  status: string;
  title: string;
  /**
   * Dependencies that are not done yet. Reported, never a reason to refuse the write or to hide the item.
   *
   * **Each carries its own status**, because whether an unmet dependency actually stops you is a project
   * convention rather than something this tool can know: a team that builds on unmerged branches reads
   * `[review]` as "a merge away" and carries on, while one that only builds on main reads it as a wall.
   * Showing the status lets the reader make that call; encoding a rule about which statuses block would pick
   * one of those projects and be wrong for the other.
   */
  blockedBy: { ref: string; status: string }[];
}

/** The stored refs in position order, unfiltered - what the event log records and what a rewrite replaces. */
async function storedRefs(tx: Tx, projectId: OwnedProjectId): Promise<string[]> {
  const rows = await tx
    .select({ ref: items.ref })
    .from(projectNext)
    .innerJoin(items, eq(projectNext.itemId, items.id))
    .where(eq(projectNext.projectId, projectId))
    .orderBy(asc(projectNext.position));
  return rows.map((row) => row.ref);
}

/**
 * The agreed order as it should be *shown*: still-open items, in position order, each with the dependencies
 * standing in its way.
 *
 * This is the read the context pack uses, so the filtering happens here rather than at the two call sites
 * that would otherwise each have to remember it.
 */
export async function getNext(db: Database, projectId: OwnedProjectId): Promise<NextItem[]> {
  const rows = await db
    .select({ id: items.id, ref: items.ref, status: items.status, title: items.title })
    .from(projectNext)
    .innerJoin(items, eq(projectNext.itemId, items.id))
    .where(and(eq(projectNext.projectId, projectId), isNull(items.deletedAt), notInArray(items.status, NOT_ACTIONABLE)))
    .orderBy(asc(projectNext.position));
  if (rows.length === 0) return [];

  // One query for every listed item's blockers rather than one per item, the same reason `dependencyRefsByItem`
  // exists. A soft-deleted dependency is not counted: it can never become done, so calling it a blocker would
  // mark an item permanently stuck on something nobody intends to do.
  const blocker = alias(items, "blocker");
  const edges = await db
    .select({ itemId: dependencies.itemId, ref: blocker.ref, status: blocker.status })
    .from(dependencies)
    .innerJoin(blocker, eq(dependencies.dependsOnId, blocker.id))
    .where(
      and(
        inArray(
          dependencies.itemId,
          rows.map((row) => row.id),
        ),
        isNull(blocker.deletedAt),
        ne(blocker.status, "done"),
      ),
    )
    .orderBy(asc(blocker.areaKey), asc(blocker.sortPath));

  const byItem = new Map<string, { ref: string; status: string }[]>();
  for (const edge of edges) byItem.set(edge.itemId, [...(byItem.get(edge.itemId) ?? []), { ref: edge.ref, status: edge.status }]);
  return rows.map(({ id, ...rest }) => ({ ...rest, blockedBy: byItem.get(id) ?? [] }));
}

/**
 * Replace the whole list, in the given order.
 *
 * Declarative rather than add/remove, exactly as `setDependencies` is: an agent that can only append cannot
 * correct its own mistake, and a partial mutation is how a list nobody re-examines accumulates. Passing `[]`
 * clears it.
 *
 * Positions are rewritten wholesale - delete then insert inside the transaction - because ten rows and one
 * call do not justify a fractional-index scheme, and the unique index on `(project_id, position)` would have
 * to be worked around by any scheme that reordered in place.
 *
 * Returns the list as `getNext` will show it, which can be shorter than what was written when a `done` item
 * is named. The caller is expected to say so rather than let the difference pass silently.
 */
export async function setNext(db: Database, projectId: OwnedProjectId, refs: string[], actor: Actor): Promise<NextItem[]> {
  // Deduplicated rather than refused: the primary key would reject the repeat anyway, and "you listed PROJ-8
  // twice" is not a decision the caller needs to make again.
  const wanted = [...new Set(refs)];

  await mutate(db, actor, async (tx) => {
    const targets =
      wanted.length === 0
        ? []
        : await tx
            .select({ id: items.id, ref: items.ref })
            .from(items)
            .where(and(eq(items.projectId, projectId), inArray(items.ref, wanted)));

    const found = new Map(targets.map((t) => [t.ref, t.id]));
    const missing = wanted.filter((ref) => !found.has(ref));
    if (missing.length > 0) throw new Error(`no item ${missing.map((r) => `"${r}"`).join(", ")} in this project`);

    const before = await storedRefs(tx, projectId);
    await tx.delete(projectNext).where(eq(projectNext.projectId, projectId));
    if (wanted.length > 0) {
      await tx.insert(projectNext).values(wanted.map((ref, index) => ({ projectId, itemId: found.get(ref)!, position: index })));
    }

    return {
      result: wanted,
      event: { projectId, entityType: "project", entityId: projectId, kind: "next-changed", before: { next: before }, after: { next: wanted } },
    };
  });

  return getNext(db, projectId);
}
