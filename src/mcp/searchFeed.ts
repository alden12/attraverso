/**
 * What `GET /api/search` answers (`VIEW-25`): the viewer's search box, over the same index as `search_plan`.
 *
 * One function for every host - the loopback viewer, the hosted server and the dev server - for the reason
 * `storeFeed` is one: the hosts answered `/api/store` with two shapes until `METRIC-4` added a field to only
 * one of them. A second matching rule in the browser would be worse still, since the human and the agent would
 * get differently-ranked answers to the same question.
 */
import type { Database } from "../db/client";
import { getItem } from "../domain/items";
import { getProjectByKey } from "../domain/projects";
import { search, type SearchHit } from "../domain/search";
// The snippet's match markers, for the viewer to split on (re-exported so it need not import the domain).
export { MATCH_OPEN, MATCH_CLOSE } from "../domain/search";

/** Enough to fill the dropdown under the box without scrolling it on a laptop. */
const LIMIT = 12;

/**
 * A ref as typed: a prefix and a dotted number, with a dash, a space, an underscore or nothing between them -
 * `view-34`, `proj 3`, `MCP_3.1`, `plat9`. Only a dash was accepted at first, and "proj 3" found nothing by its
 * ref, which is how people say one out loud. Loose is safe here, because a match only leads when that item exists.
 * The prefix is lazy, so `plat9` splits before the digits while `A2-1` still keeps its digit.
 */
const REF = /^([A-Za-z][A-Za-z0-9]*?)[\s_-]*(\d+(?:\.\d+)*)$/;

export interface SearchFeed {
  hits: SearchHit[];
  /** True when no document had every word, and these match any of them (`DATA-11`). */
  relaxed: boolean;
}

/** Null when the owner has no project of that key, which a host answers with a 404. */
export async function searchFeed(db: Database, ownerId: string, projectKey: string, query: string): Promise<SearchFeed | null> {
  const project = await getProjectByKey(db, ownerId, projectKey);
  if (project === null) return null;

  // As typed, and with matches bracketed rather than starred, so a body's own bold is not shown as a match.
  const { hits, relaxed } = await search(db, project.id, query, LIMIT, { prefix: true, bracketed: true });

  // **A ref goes straight to its item.** `to_tsvector` splits `VIEW-34` into pieces and ranks it like any other
  // word, so the item someone named exactly could come back third, or not at all if its own text never repeats
  // its ref. Typing a ref is asking for that item, so it leads, and its other hits keep their order beneath it.
  const named = REF.exec(query.trim());
  if (named !== null) {
    const item = await getItem(db, project.id, `${named[1]!.toUpperCase()}-${named[2]}`);
    if (item !== null && item.deletedAt === null) {
      const lead: SearchHit = { source: "item", ref: item.ref, id: item.ref, title: item.title, snippet: "", rank: Number.MAX_VALUE, audience: null, at: item.updatedAt };
      return { hits: [lead, ...hits.filter((hit) => !(hit.source === "item" && hit.ref === item.ref))].slice(0, LIMIT), relaxed: false };
    }
  }
  return { hits, relaxed };
}
