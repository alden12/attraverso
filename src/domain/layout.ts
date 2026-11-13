/**
 * The graph layout's memory (`VIEW-23.1`): where each node of a project's graph sits, so the map keeps its shape
 * as the plan changes and is the same map on a laptop and a phone.
 *
 * The viewer computes it (the layout is a browser concern, in `roadmap/graph.ts`) and hands the whole of it back
 * to be stored; nothing here interprets a position. It lives in the database rather than in the browser so that
 * it travels with the plan - committed in the plan file, carried by an export - which is the difference between
 * "my map" and "the project's map".
 */
import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { layoutPositions } from "../db/schema";
import { mutate, type Actor } from "./events";
import type { OwnedProjectId } from "./owned";

/** A node id (an item ref, or `area:KEY`) to its position relative to its container. */
export type Layout = Record<string, { x: number; y: number }>;

export async function getLayout(db: Database, projectId: OwnedProjectId): Promise<Layout> {
  const rows = await db.select().from(layoutPositions).where(eq(layoutPositions.projectId, projectId)).orderBy(asc(layoutPositions.node));
  return Object.fromEntries(rows.map((row) => [row.node, { x: row.x, y: row.y }]));
}

/**
 * Replace a project's layout with the one given, which is always the whole of it: the viewer saves the layout
 * it just drew, so a node missing from it is a node that no longer exists, and keeping its position would only
 * leave a stale row behind.
 *
 * The event records only what moved, not both whole layouts: a save follows every drag and every plan change
 * the viewer draws, and two copies of a few hundred positions per save would make the event log mostly layout.
 * An unchanged layout writes nothing at all, so a viewer re-saving what it was handed is free.
 */
export async function setLayout(db: Database, projectId: OwnedProjectId, layout: Layout, actor: Actor): Promise<void> {
  for (const [node, at] of Object.entries(layout)) {
    if (node.length === 0 || !Number.isInteger(at.x) || !Number.isInteger(at.y)) {
      throw new Error(`a layout position must be a node id with whole-number x and y, not ${JSON.stringify({ [node]: at })}`);
    }
  }
  const before = await getLayout(db, projectId);
  const same = (a?: { x: number; y: number }, b?: { x: number; y: number }) => a?.x === b?.x && a?.y === b?.y;
  const moved = Object.keys(layout).filter((node) => !same(before[node], layout[node]));
  const dropped = Object.keys(before).filter((node) => !(node in layout));
  if (moved.length === 0 && dropped.length === 0) return;

  await mutate(db, actor, async (tx) => {
    await tx.delete(layoutPositions).where(eq(layoutPositions.projectId, projectId));
    const rows = Object.entries(layout).map(([node, at]) => ({ projectId, node, x: at.x, y: at.y }));
    if (rows.length > 0) await tx.insert(layoutPositions).values(rows);
    const pick = (from: Layout, nodes: string[]) => Object.fromEntries(nodes.filter((node) => node in from).map((node) => [node, from[node]]));
    return {
      result: undefined,
      event: {
        projectId,
        entityType: "project",
        entityId: projectId,
        kind: "layout-changed",
        before: pick(before, [...moved, ...dropped]),
        after: pick(layout, moved),
      },
    };
  });
}
