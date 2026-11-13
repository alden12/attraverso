/**
 * The plan's version token (`VIEW-7`), which `/api/changes` pushes to an open viewer whenever it moves, so the
 * page can refetch through the route it already has. **A notification, never the data**: a missed or coalesced
 * change corrects itself on the next one, and there is one loading path rather than two that could disagree.
 *
 * **The token is the latest event**, because every mutation writes one in the same transaction (`CLAUDE.md`), in
 * file mode and database mode alike. Two adjustments:
 *
 * - **Reloads from disk count too** (`reloads`): a `git pull` or a hand edit rebuilds the database through
 *   `replaceStore`, which clears the event log, so the latest event can go back to nothing - and two such
 *   reloads in a row would both read as nothing. A count of them, from the store, keeps every one distinct.
 * - **The viewer's own layout saves do not count.** The layout is the viewer's memory, saved after every draw and
 *   drag (`VIEW-23.1`); counting it would have every open tab refetch the whole plan after each move it made.
 */
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { rowsOf } from "../db/rows";

export async function versionFeed(db: Database, ownerId: string, reloads: number): Promise<{ version: string }> {
  const [row] = rowsOf<{ latest: string | null }>(
    await db.execute(sql`
      SELECT max(e.id) AS latest
        FROM events e
        JOIN projects p ON p.id = e.project_id
       WHERE p.owner_id = ${ownerId}
         AND e.kind <> 'layout-changed'
    `),
  );
  return { version: `${reloads}:${row?.latest ?? "-"}` };
}
