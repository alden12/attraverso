/**
 * `resumeProject` assembles what a returning session opens with (MCP-8): one read, deliberately small.
 *
 * **It is a composition, not a bespoke assembly (CTX-4).** What it returns is the protocol section plus
 * `list_tickets` plus `list_context` plus the project header, and that is the whole design. Two things follow
 * from saying it that way rather than hand-picking fields:
 *
 * - **One formatter per thing.** The pack used to render sections, items and comments its own way while each
 *   tool rendered the same rows differently, which is how two renderings of one row drift. Now improving
 *   `list_tickets` improves the pack for free.
 * - **Nothing is reachable only through resume.** Whatever a session learns at startup it can re-derive by
 *   calling the parts, so there is no privileged data path.
 *
 * **The pack is an index, not content.** Measured 2026-09-01 it was 55kB: 28kB of comments selected by
 * recency alone, 21kB of context sections carried in full, and 6kB of ticket titles for 122 items. The titles
 * were by far the best value per byte and the only part that is genuinely a board. So sections are now
 * *named* and opened on demand with `get_context` (exactly the pattern tickets already used - titles in the
 * pack, bodies on demand), comments are dropped entirely, and only `protocol` is carried in full because
 * `CTX-9` makes it read-every-session by design.
 *
 * **What a returning session loses, asked deliberately before cutting 85%:** "what happened last time" is
 * `git log` and the `in-progress` statuses already here; "what did we decide about X" is `search_plan`; "how
 * do I operate here" is the protocol. Nothing was left uncovered, which is what makes the cut defensible
 * rather than reckless.
 *
 * **So the pack has to say what it is not showing, and how to reach it** - `held` exists for that line. With
 * this much held back, an agent that does not know to look is the exact failure `MCP-24` was filed about, and
 * this ticket's standing rule is that truncation is always announced, never silent.
 *
 * **The board is the part that grows without bound, so `PROJ-8` bounded it.** Measured 2026-09-02, the open
 * listing was 7.6kB of titles over 126 items - the largest single thing here, and the only one with no
 * ceiling. Past `FULL_BOARD_LIMIT` the pack carries what is in flight and what was agreed next instead, and
 * counts the rest by status. A threshold and not a truncation: slicing the first 30 by (area, sort_path)
 * would be an alphabetical prefix presented as a board.
 *
 * There is no `checkpointSession` counterpart any more (`CTX-10`): a call that only fires at a tidy ending
 * never fires, so everything that matters is written when it happens.
 */
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { Database } from "../db/client";
import { maybeOne } from "../db/rows";
import { items, projects } from "../db/schema";
import type { OwnedProjectId } from "./owned";
import { listSections, PROTOCOL_HEADING } from "./context";
import { countComments } from "./comments";
import { getNext, type NextItem } from "./next";
import { listAreas, type AreaSummary } from "./areas";

/** One board line. The same three fields `list_items` renders, because the pack must not be a second
 *  rendering of the same row (`CTX-4`). */
export interface PackItem {
  ref: string;
  status: string;
  title: string;
}

/**
 * How many open items the pack will carry in full.
 *
 * **A threshold, not a truncation.** Showing the first N of 128 by (area, sort_path) would be an alphabetical
 * prefix dressed up as a board - it would read as "here is what matters" while meaning "here is area A". So
 * the board is either carried whole or replaced by the two groups a session acts on, and never sliced.
 *
 * 30 lines is roughly 2.5kB, about what the protocol costs, and about where a board stops being scannable
 * anyway. Under it, trimming saves nothing worth the ambiguity; over it, the listing is the only part of the
 * pack that grows without bound (measured 2026-09-02: 128 open items, 10.8kB of a 13.8kB pack).
 */
export const FULL_BOARD_LIMIT = 30;

export type PackBoard =
  /** Every open item, as the pack has always carried them. A small project loses nothing here. */
  | { kind: "full"; items: PackItem[] }
  /**
   * The two groups a session acts on, and a count of what that leaves behind.
   *
   * They answer different questions and are kept apart for that reason: `inProgress` is "where was I",
   * `next` is "what did we agree" (`PROJ-8`). An item in both appears only under `next`.
   */
  | {
      kind: "trimmed";
      inProgress: PackItem[];
      next: NextItem[];
      /**
       * The project's areas, named and counted - the map that the full listing used to convey by accident.
       * Carried only here, because while every title is shown the areas are already visible in them.
       */
      areas: AreaSummary[];
      /** Open items not listed above. By status, because `list_items` filters by status, so "24 to-do" plus
       *  that tool is a decision a caller can act on where a bare total is only a number. */
      held: { total: number; byStatus: { status: string; count: number }[] };
    };

export interface ContextPack {
  project: { key: string; name: string; type: string; direction: string | null };
  /** The protocol section's content, in full. Null for a project that has none yet. */
  protocol: string | null;
  /** Every *other* section, named only. A table of contents, opened with `get_context`. */
  sectionHeadings: string[];
  board: PackBoard;
  /** What the pack deliberately does not carry, so the reply can name it and say how to reach it. */
  held: { sections: number; comments: number };
}

export async function resumeProject(db: Database, projectId: OwnedProjectId): Promise<ContextPack> {
  const project = maybeOne(await db.select().from(projects).where(eq(projects.id, projectId)));
  if (project === null) throw new Error("no such project");

  const sections = await listSections(db, projectId);
  const protocol = sections.find((s) => s.heading === PROTOCOL_HEADING) ?? null;
  const rest = sections.filter((s) => s.heading !== PROTOCOL_HEADING);
  // Open = not done, not soft-deleted. Ordered like the board (area, then sort_path), which is the same order
  // `list_items` returns - the pack and the tool must not disagree about what the board is.
  //
  // Fetched whole even when most of it is about to be discarded, because the counting has to be exact: the
  // held line subtracts what is shown from what exists, and doing that with a GROUP BY plus a second query
  // would be two roundtrips to answer what one array already answers. Three columns over a few hundred rows,
  // on an in-memory database.
  const open = await db
    .select({ ref: items.ref, status: items.status, title: items.title })
    .from(items)
    .where(and(eq(items.projectId, projectId), isNull(items.deletedAt), ne(items.status, "done")))
    .orderBy(asc(items.areaKey), asc(items.sortPath));

  return {
    project: { key: project.key, name: project.name, type: project.type, direction: project.direction },
    protocol: protocol?.content ?? null,
    sectionHeadings: rest.map((s) => s.heading),
    board: open.length <= FULL_BOARD_LIMIT ? { kind: "full", items: open } : await trimBoard(db, projectId, open),
    // A count, not the rows: it is one integer that turns "nothing is shown" into "31 comments are not shown,
    // here is the tool". Cheap enough to run on the first call of every session.
    held: { sections: rest.length, comments: await countComments(db, projectId) },
  };
}

/**
 * The board for a project too big to carry whole: what is in flight, what was agreed next, and a count of the
 * rest by status.
 *
 * The held count is derived by subtracting the shown refs from `open` rather than counted separately, so the
 * two can never disagree - "113 more" that overlaps the list printed above it is the kind of thing that gets
 * misread once and then distrusted.
 */
async function trimBoard(db: Database, projectId: OwnedProjectId, open: PackItem[]): Promise<PackBoard> {
  const next = await getNext(db, projectId);
  const inNext = new Set(next.map((n) => n.ref));
  // An item that is both in flight and agreed-next appears once, under `next`, where the ordering is the point.
  const inProgress = open.filter((item) => item.status === "in-progress" && !inNext.has(item.ref));

  const shown = new Set([...inNext, ...inProgress.map((item) => item.ref)]);
  const counts = new Map<string, number>();
  for (const item of open) {
    if (shown.has(item.ref)) continue;
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  }

  return {
    kind: "trimmed",
    inProgress,
    next,
    areas: await listAreas(db, projectId),
    held: {
      total: open.length - shown.size,
      // Descending, so the biggest pile leads: that is the one a caller is most likely to want a tool for.
      byStatus: [...counts].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
    },
  };
}
