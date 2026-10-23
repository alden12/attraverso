/**
 * The generated `tsvector` columns (`DATA-11`).
 *
 * The whole argument for a generated column over a separate index table is that **Postgres maintains it
 * inside the same write**, so it cannot drift and no code has to remember to reindex. That is a claim about
 * the database rather than about our code, and it is exactly the sort of claim that is assumed rather than
 * checked - so these tests drive the real schema and assert the column moves on its own.
 *
 * Deliberately at the schema level rather than through a `SearchIndex`: what is being proved here is that the
 * DDL is right. Ranking, snippets and scoping belong to the interface built on top of it.
 */
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { freshDb } from "./testing";
import { items, comments, TEXT_SEARCH_CONFIG } from "./schema";
import { createProject } from "../domain/projects";
import { createItem, editItem } from "../domain/items";
import { addComment } from "../domain/comments";

const ACTOR = "test";

/** The stored vector for one item, as text, which is how a `tsvector` reads back. */
const vectorOf = async (db: Awaited<ReturnType<typeof freshDb>>["db"], id: string): Promise<string> => {
  const [row] = await db.select({ tsv: sql<string>`${items.tsv}::text` }).from(items).where(eq(items.id, id));
  return row?.tsv ?? "";
};

describe("generated search vectors (DATA-11)", () => {
  it("populates on insert, without anything asking it to", async () => {
    const { db, ownerId, close } = await freshDb();
    const project = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const item = await createItem(db, { projectId: project.id, area: "DATA", title: "Search index", body: "Full-text search over item bodies." }, ACTOR);

    const tsv = await vectorOf(db, item.id);
    // Stemmed and weighted: `index` from the title carries an `A`, `bodi` (the stem of "bodies") a `B`.
    expect(tsv).toContain("'index'");
    expect(tsv).toMatch(/'index':\d+A/);
    expect(tsv).toMatch(/'bodi':\d+B/);
    await close();
  });

  it("follows an edit, so the index cannot go stale behind the row", async () => {
    const { db, ownerId, close } = await freshDb();
    const project = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const item = await createItem(db, { projectId: project.id, area: "DATA", title: "Search index", body: "Nothing to see." }, ACTOR);
    expect(await vectorOf(db, item.id)).not.toContain("'postgr'");

    // The point of the whole design: no reindex call anywhere, and the column still moves.
    await editItem(db, { projectId: project.id, ref: item.ref, body: "Rewritten to mention Postgres." }, ACTOR);
    // `postgr`, not `postgres` - the stored form is the *stem*, which is the same reason a search for
    // "rendering" finds "rendered". Asserting on the raw word would pass only by accident.
    expect(await vectorOf(db, item.id)).toContain("'postgr'");
    await close();
  });

  it("ranks a title match above a body match for the same term", async () => {
    const { db, ownerId, close } = await freshDb();
    const project = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    // Same word, same document length, differing only in which field carries it - so weight is the only
    // thing that can separate them.
    const titled = await createItem(db, { projectId: project.id, area: "DATA", title: "Hono", body: "One two three four." }, ACTOR);
    const bodied = await createItem(db, { projectId: project.id, area: "DATA", title: "One two", body: "Hono three four." }, ACTOR);

    const ranked = await db
      .select({ id: items.id, rank: sql<number>`ts_rank(${items.tsv}, websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, 'hono'))` })
      .from(items)
      .where(sql`${items.tsv} @@ websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, 'hono')`)
      .orderBy(sql`2 DESC`);

    expect(ranked.map((r) => r.id)).toEqual([titled.id, bodied.id]);
    await close();
  });

  it("indexes a comment's body, which is where most of the prose actually is", async () => {
    const { db, ownerId, close } = await freshDb();
    const project = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const item = await createItem(db, { projectId: project.id, area: "MCP", title: "server" }, ACTOR);
    await addComment(db, { projectId: project.id, itemId: item.id, body: "Decided against Express because of the stdout audit." }, ACTOR);

    const [row] = await db
      .select({ tsv: sql<string>`${comments.tsv}::text` })
      .from(comments)
      .where(sql`${comments.tsv} @@ websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, 'stdout audit')`);
    expect(row?.tsv).toContain("'stdout'");
    await close();
  });

  it("matches a phrase as a phrase, and honours an exclusion", async () => {
    const { db, ownerId, close } = await freshDb();
    const project = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: project.id, area: "DATA", title: "Backend framework", body: "" }, ACTOR);
    await createItem(db, { projectId: project.id, area: "DATA", title: "Framework for the backend", body: "" }, ACTOR);

    const matching = async (query: string): Promise<number> => {
      const rows = await db
        .select({ id: items.id })
        .from(items)
        .where(sql`${items.tsv} @@ websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${query})`);
      return rows.length;
    };

    // Both contain the words; only one has them adjacent in that order.
    expect(await matching("backend framework")).toBe(2);
    expect(await matching('"backend framework"')).toBe(1);
    // `websearch_to_tsquery` reads a leading `-` as "and not".
    expect(await matching("framework -backend")).toBe(0);
    await close();
  });

  it("returns nothing rather than throwing on a query no person would type", async () => {
    const { db, ownerId, close } = await freshDb();
    const project = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: project.id, area: "DATA", title: "Search index", body: "" }, ACTOR);

    // This is why `websearch_to_tsquery` and not `to_tsquery`: the latter raises a syntax error on input like
    // this, and the query string here is composed by an agent rather than typed into a box.
    for (const query of ["&&& |", '"unclosed', "!!!", ""]) {
      const rows = await db
        .select({ id: items.id })
        .from(items)
        .where(sql`${items.tsv} @@ websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${query})`);
      expect(rows).toHaveLength(0);
    }
    await close();
  });
});
