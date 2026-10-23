/**
 * Full-text search across a project's prose (`DATA-11`, the retrieval half of `MCP-24`).
 *
 * The plan holds far more written reasoning than any context pack can carry - 378kB against the ~55kB
 * `get_project` returns, measured 2026-09-01 - so everything recorded is retrievable in principle and, until
 * this existed, findable only by an agent that already suspected it existed and knew roughly where to look.
 * That failed twice for real: a decision about markdown editing was nearly re-derived (`VIEW-19`), and a whole
 * ticket was filed as a duplicate of one three weeks older whose argument was better (`OPS-15` against
 * `VIEW-20`). Both are recorded on `MCP-24`.
 *
 * **Snippets, never documents.** Five full hits is roughly 2,200 tokens against roughly 150 for five snippets.
 * That ratio is the whole design: a hit that is not opened must cost almost nothing, which is what makes it
 * safe to search speculatively, which is the only way an agent searches at all. The caller opens what it wants
 * with `get_ticket` or `list_comments`.
 *
 * **The index itself is not here.** `schema.ts` carries a generated `tsvector` column per searchable table,
 * maintained by Postgres inside the same write, so nothing in this file has to keep an index in step with a
 * row. This module is only the query.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/client";
import { rowsOf } from "../db/rows";
import { TEXT_SEARCH_CONFIG } from "../db/schema";
import type { OwnedProjectId } from "./owned";
import type { Audience } from "./comments";

/** Which table a hit came from. Returned so a caller knows which tool opens it. */
export type SearchSource = "item" | "comment" | "context";

export interface SearchHit {
  source: SearchSource;
  /**
   * The item this hit is about: its own ref for an item, or the ref of the item a comment hangs off. Null when
   * the hit belongs to the project directly - a loose comment, or a context section.
   */
  ref: string | null;
  /** How to address the thing itself: a ref, a comment id, a section heading. */
  id: string;
  /** An item's title or a section's heading. Null where the source has no title (comments). */
  title: string | null;
  /** `ts_headline` fragments, matched terms wrapped in `**`. */
  snippet: string;
  rank: number;
  /**
   * `agent` for Claude's own working comments, null for everything else.
   *
   * Tagged rather than filtered, deliberately, matching what `get_project` already does. Agent comments are
   * the thing an agent most needs handed back, and they are unsurfaced by default rather than secret.
   */
  audience: Audience | null;
  /** When the hit was last written. Also the tiebreak when two things rank identically. */
  at: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /**
   * True when no document contained *every* term and the search was relaxed to "any of them".
   *
   * Surfaced rather than hidden because the caller's precision quietly dropped: a hit matching two words of
   * six should not read like one that matched all six.
   */
  relaxed: boolean;
}

/**
 * The seam. One implementation today (`postgresSearch`), and the interface remains **only** as a hedge for a
 * possible future vector or hybrid search.
 *
 * It is emphatically not here to bridge dialects: that reason existed when local was SQLite and cloud was
 * Postgres, and it died with the storage pivot. Both are Postgres now, so a second implementation would be a
 * different *kind* of search rather than the same search spoken differently.
 */
export interface SearchIndex {
  search(projectId: OwnedProjectId, query: string, limit?: number): Promise<SearchResult>;
}

/** How many hits a search returns when the caller does not say. Sized so a full page of snippets stays cheap. */
export const DEFAULT_LIMIT = 8;

/**
 * How much an item outranks a comment or a context section at the same textual relevance.
 *
 * **A starting guess, and explicitly a knob to tune** (`DATA-11` slice 4). The reasoning is that an item is a
 * thing you act on and so is usually the more useful answer to "what do we know about X", while a comment is
 * evidence about it. That is a hypothesis about how this gets used, and there was no usage to check it against
 * when it was written. Revisit against real searches rather than by arguing about the number.
 */
const ITEM_BOOST = 1.5;

/**
 * `MaxFragments=2` so a long body can contribute two separate matching passages rather than one window that
 * happens to cover the first hit. `**` rather than the default `<b>`, because these are read by an agent and
 * rendered as markdown, not as HTML.
 */
const HEADLINE_OPTIONS = "MaxFragments=2,MinWords=6,MaxWords=18,StartSel=**,StopSel=**,FragmentDelimiter= ... ";

interface HitRow {
  source: SearchSource;
  ref: string | null;
  id: string;
  title: string | null;
  snippet: string;
  rank: number;
  audience: Audience | null;
  at: string;
}

/**
 * Why a **term-dense** query can match nothing at all - which is not the same as a long one.
 *
 * `websearch_to_tsquery` joins terms with **AND**, so "optional flag tool argument the model chooses" becomes
 * `option & flag & tool & argument & model & choos` - six stems required in a single document. Measured
 * against this project's own 152 items on 2026-09-01, that matched **nothing**; the same terms OR-ed matched
 * 93.
 *
 * **Length is the wrong diagnosis, and the first version of this comment gave it.** Stop words are stripped
 * before the AND applies, and an English question is mostly stop words, so it collapses to very few terms:
 *
 *   7 words  ->  3 terms   'viewer' & 'authent' & 'user'      ("how does the viewer authenticate a user")
 *   5 words  ->  2 terms   'choos' & 'postgr'                 ("why did we choose postgres")
 *   7 words  ->  6 terms   'option' & 'flag' & 'tool' & ...   (the query above)
 *
 * The failing one is a *list of nouns*, which is what a query written as a description of a concept looks
 * like. Fifteen realistic questions against the real store all matched strictly, including every long one, so
 * **the fallback below is a rare safety net rather than the normal path** - which is what keeps `relaxed`
 * meaningful as a signal and keeps the second query off the common path.
 *
 * It also explains why the miss reply's nudge works: telling someone to use the words that would appear in
 * the writing is telling them to write a sentence, and sentences survive the AND.
 *
 * So when the strict query finds nothing, relax it to "any of these" and let ranking sort out the flood. On
 * the query that actually failed, this returns the right ticket first.
 *
 * **Only when the strict query found nothing**, never by default: AND is right whenever it matches, and 93
 * ranked hits is a worse answer than 4 matched ones. Always relaxing would also make "nothing is recorded
 * about this" unsayable, and that is a real answer the caller wanted.
 *
 * **And only when relaxing is meaningful and safe**, which is two conditions:
 *
 * - The query must contain a top-level `&`. A single term has nothing to relax, and re-running it as itself
 *   is a wasted scan.
 * - It must contain no `!`. `framework -backend` renders as `framework & !backend`, and rewriting that to
 *   `framework | !backend` matches nearly every document in the project - an exclusion turned into a wildcard.
 *   Someone who wrote an exclusion was being precise, so the honest answer there is the empty one.
 *
 * A quoted phrase renders with `<->` rather than `&` and so passes through untouched, which is the behaviour
 * you want: `"backend framework"` stays a phrase in both passes.
 */
const relaxable = (tsquery: string): boolean => tsquery.includes(" & ") && !tsquery.includes("!");

/** The strict query, and the same query with its top-level ANDs turned into ORs. */
const AND_QUERY = (query: string) => sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${query})`;
const OR_QUERY = (query: string) =>
  sql`replace(websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${query})::text, ' & ', ' | ')::tsquery`;

/**
 * Search one project's items, comments and context sections in a single query.
 *
 * **Ranking and snippets are separated on purpose.** The inner select matches and ranks over the GIN indexes
 * and is cut to `limit`; only then does the outer select call `ts_headline`, which is the expensive part
 * because it re-parses the document text it is quoting from. Running it before the cut would headline every
 * match in the project to throw nearly all of them away.
 *
 * **Scoping is the security boundary.** `projectId` is an `OwnedProjectId`, so it cannot be reached without
 * having gone through `resolveProject` - which matters more here than almost anywhere else, since this is a
 * query over every row of prose in the database and an unscoped one would return another owner's plan.
 * Soft-deleted items are excluded for the same class of reason: there is no hard-delete path, so a deleted
 * ticket is still a row and would otherwise surface as a live one.
 */
export async function search(
  db: Database,
  projectId: OwnedProjectId,
  query: string,
  limit: number = DEFAULT_LIMIT,
): Promise<SearchResult> {
  // An empty query matches nothing, and `websearch_to_tsquery` would agree - but it would still cost a scan of
  // four tables to say so, and callers do send one (a cleared search box, an agent building a query from a
  // field that turned out to be blank).
  if (query.trim() === "") return { hits: [], relaxed: false };

  const strict = await matching(db, projectId, AND_QUERY(query), sql`ts_rank`, limit);
  if (strict.length > 0) return { hits: strict, relaxed: false };

  // One extra round trip, and only on a miss - which is already the cheap path.
  const [built] = rowsOf<{ tsq: string }>(await db.execute(sql`SELECT ${AND_QUERY(query)}::text AS tsq`));
  if (built === undefined || !relaxable(built.tsq)) return { hits: [], relaxed: false };

  // **`ts_rank`, not `ts_rank_cd`.** This was `ts_rank_cd` first, on the reasoning that once the query is a
  // disjunction the useful question becomes "how many of these terms cluster here". That sounds right and is
  // wrong, because clustering is not counting - measured 2026-09-01 against four documents matching a
  // different number of the query's terms:
  //
  //   ts_rank      4-of-4 > 3-of-4 > 2-of-4 > one term repeated ten times
  //   ts_rank_cd   one term repeated ten times > 4-of-4 > 3-of-4 > 2-of-4
  //
  // `ts_rank` already ranks by how many *distinct* terms a document matched, which is exactly what this pass
  // wants, and it correctly sinks a document that merely repeats one of them. Cover density measures how
  // densely the query covers the document, so ten hits of one term in a ten-word document scores perfectly -
  // the precise inversion of what a relaxed search needs. The real store hid this because both rankers happened
  // to agree on the query it was tested with.
  const loose = await matching(db, projectId, OR_QUERY(query), sql`ts_rank`, limit);
  return { hits: loose, relaxed: loose.length > 0 };
}

/** One pass of the search, for a given tsquery expression and ranking function. */
async function matching(
  db: Database,
  projectId: OwnedProjectId,
  q: SQL,
  rank: SQL,
  limit: number,
): Promise<SearchHit[]> {
  const result = await db.execute(sql`
    WITH matches AS (
      SELECT 'item' AS source,
             i.ref AS ref,
             i.ref AS id,
             i.title AS title,
             coalesce(i.body, '') AS text,
             NULL::text AS audience,
             i.updated_at AS at,
             ${rank}(i.tsv, ${q}) * ${ITEM_BOOST} AS rank
        FROM items i
       WHERE i.project_id = ${projectId}
         AND i.deleted_at IS NULL
         AND i.tsv @@ ${q}

      UNION ALL

      -- A comment's ref is its *item's* ref, so a hit says which ticket it is evidence about. Left join because
      -- a comment may hang off the project directly rather than off any item.
      SELECT 'comment', it.ref, n.id, NULL, n.body, n.audience, n.created_at, ${rank}(n.tsv, ${q})
        FROM comments n
        LEFT JOIN items it ON it.id = n.item_id
       WHERE n.project_id = ${projectId}
         AND n.tsv @@ ${q}

      UNION ALL

      -- A section is addressed by its heading, which is also its identity in the store.
      SELECT 'context', NULL, c.heading, c.heading, c.content, NULL, c.updated_at, ${rank}(c.tsv, ${q})
        FROM context_sections c
       WHERE c.project_id = ${projectId}
         AND c.tsv @@ ${q}
    ),
    top AS (
      -- Recency breaks a rank tie: between two equally relevant comments, the later one is the more likely to
      -- still be true. Deterministic on id after that, so a page never reshuffles between identical calls.
      SELECT * FROM matches ORDER BY rank DESC, at DESC, id ASC LIMIT ${limit}
    )
    SELECT source, ref, id, title, audience, at, rank,
           ts_headline(${TEXT_SEARCH_CONFIG}, text, ${q}, ${HEADLINE_OPTIONS}) AS snippet
      FROM top
     ORDER BY rank DESC, at DESC, id ASC
  `);

  return rowsOf<HitRow>(result).map((row) => ({
    source: row.source,
    ref: row.ref,
    id: row.id,
    title: row.title,
    snippet: row.snippet,
    // `ts_rank` is a float4; node-postgres hands floats back as numbers but PGlite has been seen to return a
    // string for some numeric types, so this is normalised once here rather than at every call site.
    rank: Number(row.rank),
    audience: row.audience,
    at: row.at,
  }));
}

/** The one implementation, bound to a database handle. */
export const postgresSearch = (db: Database): SearchIndex => ({
  search: (projectId, query, limit) => search(db, projectId, query, limit),
});
