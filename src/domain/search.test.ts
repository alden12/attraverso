/**
 * Search over a project's prose (`DATA-11`).
 *
 * Two of these are load-bearing rather than descriptive. **Owner scoping** is the security boundary: this is a
 * query over every row of prose in the database, so a missing `project_id` predicate returns another person's
 * plan, and the `OwnedProjectId` brand only guarantees that a check *happened*, not that the SQL used its
 * result. **Soft-delete exclusion** is the same shape of mistake one notch quieter: there is no hard-delete
 * path here, so a deleted ticket is still a row.
 *
 * The rest pin down behaviour that would otherwise be re-derived by whoever tunes ranking next.
 */
import { describe, expect, it } from "vitest";
import { freshDb } from "../db/testing";
import { createProject } from "./projects";
import { createItem, deleteItem, editItem } from "./items";
import { addComment } from "./comments";
import { setSection } from "./context";
import { ensureUser } from "./users";
import { search, postgresSearch, DEFAULT_LIMIT } from "./search";

const ACTOR = "test";

/** Just the hits, for the tests that do not care whether the search was relaxed. */
const hitsOf = async (...args: Parameters<typeof search>) => (await search(...args)).hits;

/** A project with one owner, plus a second owner's project, so scoping has something to leak into. */
async function twoProjects() {
  const fixture = await freshDb();
  const mine = await createProject(fixture.db, { key: "mine", name: "Mine", type: "software", ownerId: fixture.ownerId }, ACTOR);
  return { ...fixture, mine };
}

describe("search (DATA-11)", () => {
  it("finds an item by words in its body, and says where the hit came from", async () => {
    const { db, mine, close } = await twoProjects();
    await createItem(db, { projectId: mine.id, area: "VIEW", title: "Move the host onto Hono", body: "Should the viewer host use a backend framework rather than raw node:http?" }, ACTOR);
    await createItem(db, { projectId: mine.id, area: "DATA", title: "Search index", body: "Full-text search over item bodies." }, ACTOR);

    const [hit, ...rest] = await hitsOf(db, mine.id, "backend framework");
    expect(rest).toHaveLength(0);
    expect(hit?.source).toBe("item");
    expect(hit?.ref).toBe("VIEW-1");
    expect(hit?.title).toBe("Move the host onto Hono");
    // The snippet quotes the matching passage with the matched terms marked, not the whole body.
    expect(hit?.snippet).toContain("**backend**");
    expect(hit?.snippet).toContain("**framework**");
    expect(hit?.snippet.length).toBeLessThan(200);
    await close();
  });

  it("never returns another owner's rows, even when they match better", async () => {
    const { db, mine, close } = await twoProjects();
    // A second person, with a project whose text is a *stronger* match than anything in the first. A real
    // `users` row rather than a made-up id, because `projects.owner_id` is a foreign key.
    const other = await ensureUser(db, { issuer: "local", subject: "someone-else" });
    const theirs = await createProject(db, { key: "theirs", name: "Theirs", type: "software", ownerId: other.id }, ACTOR);
    await createItem(db, { projectId: theirs.id, area: "SEC", title: "Hono Hono Hono", body: "Hono hono hono hono." }, ACTOR);
    await createItem(db, { projectId: mine.id, area: "VIEW", title: "Something else", body: "A passing mention of Hono." }, ACTOR);

    const hits = await hitsOf(db, mine.id, "hono");
    // Without the project_id predicate the other owner's item outranks mine and comes back first.
    expect(hits).toHaveLength(1);
    expect(hits[0]?.ref).toBe("VIEW-1");
    await close();
  });

  it("excludes a soft-deleted item, which is still a row", async () => {
    const { db, mine, close } = await twoProjects();
    const doomed = await createItem(db, { projectId: mine.id, area: "DATA", title: "Portability check", body: "Scan the DML for banned constructs." }, ACTOR);
    expect(await hitsOf(db, mine.id, "banned constructs")).toHaveLength(1);

    await deleteItem(db, { projectId: mine.id, ref: doomed.ref }, ACTOR);
    expect(await hitsOf(db, mine.id, "banned constructs")).toHaveLength(0);
    await close();
  });

  it("searches comments and context sections, not only items", async () => {
    const { db, mine, close } = await twoProjects();
    const item = await createItem(db, { projectId: mine.id, area: "OPS", title: "Deploy", body: "Nothing relevant." }, ACTOR);
    await addComment(db, { projectId: mine.id, itemId: item.id, body: "Rejected Express because of the stdout audit." }, ACTOR);
    await setSection(db, { projectId: mine.id, heading: "The storage model", content: "PGlite is rebuilt from YAML on load, an audit of nothing." }, ACTOR);

    const sources = (await hitsOf(db, mine.id, "audit")).map((h) => h.source).sort();
    expect(sources).toEqual(["comment", "context"]);

    // A comment carries the ref of the item it hangs off, so a hit says which ticket it is evidence about.
    const comment = (await hitsOf(db, mine.id, "Express")).find((h) => h.source === "comment");
    expect(comment?.ref).toBe("OPS-1");
    await close();
  });

  it("tags an agent comment rather than hiding it", async () => {
    const { db, mine, close } = await twoProjects();
    const subject = await createItem(db, { projectId: mine.id, area: "OPS", title: "Pooling" }, ACTOR);
    await addComment(db, { projectId: mine.id, itemId: subject.id, body: "Working comment: the pooler drops the advisory lock.", audience: "agent" }, ACTOR);
    await addComment(db, { projectId: mine.id, itemId: subject.id, body: "The pooler question came up again.", audience: "user" }, ACTOR);

    const hits = await hitsOf(db, mine.id, "pooler");
    expect(hits).toHaveLength(2);
    // Both come back; the audience is what lets a caller tell its own working comments from the user's.
    expect(hits.map((h) => h.audience).sort()).toEqual(["agent", "user"]);
    await close();
  });

  it("ranks an item above a comment of equal textual relevance", async () => {
    const { db, mine, close } = await twoProjects();
    const phrase = "the advisory lock is dropped by the pooler";
    await createItem(db, { projectId: mine.id, area: "OPS", title: "Pooler", body: phrase }, ACTOR);
    const commented = await createItem(db, { projectId: mine.id, area: "OPS", title: "Indexed" }, ACTOR);
    await addComment(db, { projectId: mine.id, itemId: commented.id, body: phrase }, ACTOR);

    const hits = await hitsOf(db, mine.id, "advisory lock pooler");
    expect(hits.map((h) => h.source)).toEqual(["item", "comment"]);
    await close();
  });

  it("honours a limit, and defaults to one that keeps a page cheap", async () => {
    const { db, mine, close } = await twoProjects();
    for (let n = 0; n < DEFAULT_LIMIT + 4; n += 1) {
      await createItem(db, { projectId: mine.id, area: "DATA", title: `Ticket ${n}`, body: "All of these mention Postgres." }, ACTOR);
    }
    expect(await hitsOf(db, mine.id, "postgres")).toHaveLength(DEFAULT_LIMIT);
    expect(await hitsOf(db, mine.id, "postgres", 3)).toHaveLength(3);
    await close();
  });

  it("returns nothing, rather than throwing, for an empty or unparseable query", async () => {
    const { db, mine, close } = await twoProjects();
    await createItem(db, { projectId: mine.id, area: "DATA", title: "Search index", body: "Full-text search." }, ACTOR);
    // The empty case short-circuits; the rest reach `websearch_to_tsquery`, which is chosen over `to_tsquery`
    // precisely because it does not raise on input like this. The query string is composed by an agent.
    for (const query of ["", "   ", "&&& |", '"unclosed', "!!!"]) {
      expect(await hitsOf(db, mine.id, query)).toEqual([]);
    }
    await close();
  });

  it("follows an edit, because the index is a generated column", async () => {
    const { db, mine, close } = await twoProjects();
    const item = await createItem(db, { projectId: mine.id, area: "DATA", title: "Placeholder", body: "Nothing here yet." }, ACTOR);
    expect(await hitsOf(db, mine.id, "drizzle")).toHaveLength(0);

    await editItem(db, { projectId: mine.id, ref: item.ref, body: "Storage uses Drizzle over pg-core." }, ACTOR);
    expect(await hitsOf(db, mine.id, "drizzle")).toHaveLength(1);
    await close();
  });

  it("exposes the same query through the SearchIndex seam", async () => {
    const { db, mine, close } = await twoProjects();
    await createItem(db, { projectId: mine.id, area: "DATA", title: "Search index", body: "Full-text search over item bodies." }, ACTOR);
    const index = postgresSearch(db);
    expect((await index.search(mine.id, "full-text")).hits).toHaveLength(1);
    await close();
  });

  /**
   * The OR fallback (`DATA-11` slice 4). `websearch_to_tsquery` ANDs every term, so a carefully-worded query
   * requires *every* stem in one document - which is why a six-word query matched nothing at all across this
   * project's 152 items while the same terms OR-ed matched 93.
   */
  describe("relaxing a query that matched nothing", () => {
    it("falls back to any-of when no document has all the terms", async () => {
      const { db, mine, close } = await twoProjects();
      await createItem(db, { projectId: mine.id, area: "MCP", title: "Tool replies are prose", body: "A program has to regex them, so the model cannot help." }, ACTOR);
      await createItem(db, { projectId: mine.id, area: "OPS", title: "Unrelated", body: "Nothing to do with any of this." }, ACTOR);

      // Every term present in no single document, so the strict pass finds nothing.
      const strict = await search(db, mine.id, "optional flag tool argument the model chooses");
      expect(strict.relaxed).toBe(true);
      expect(strict.hits[0]?.ref).toBe("MCP-1");
      await close();
    });

    it("does not relax when the strict query already matched", async () => {
      const { db, mine, close } = await twoProjects();
      await createItem(db, { projectId: mine.id, area: "MCP", title: "Tool replies are prose", body: "A program has to regex them." }, ACTOR);
      await createItem(db, { projectId: mine.id, area: "OPS", title: "Tooling", body: "Mentions a program and nothing else." }, ACTOR);

      const result = await search(db, mine.id, "prose regex");
      expect(result.relaxed).toBe(false);
      // Relaxing here would have dragged in OPS-1 on "program" alone, which is the thing not to do.
      expect(result.hits).toHaveLength(1);
      await close();
    });

    /**
     * The trap the naive rewrite falls into. `framework -backend` renders as `framework & !backend`, so
     * turning ` & ` into ` | ` yields `framework | !backend` - an exclusion become a wildcard, matching very
     * nearly every document in the project. Someone who wrote an exclusion meant it, so the empty answer is
     * the honest one.
     */
    it("refuses to relax a query carrying an exclusion", async () => {
      const { db, mine, close } = await twoProjects();
      await createItem(db, { projectId: mine.id, area: "VIEW", title: "Backend framework", body: "" }, ACTOR);
      await createItem(db, { projectId: mine.id, area: "OPS", title: "Entirely different", body: "No overlap at all." }, ACTOR);

      const result = await search(db, mine.id, "framework -backend");
      expect(result.hits).toEqual([]);
      expect(result.relaxed).toBe(false);
      await close();
    });

    it("does not spend a second query relaxing a single term", async () => {
      const { db, mine, close } = await twoProjects();
      await createItem(db, { projectId: mine.id, area: "DATA", title: "Search index", body: "Full-text search." }, ACTOR);
      // Nothing to relax: `kubernetes` OR-ed with itself is still `kubernetes`.
      const result = await search(db, mine.id, "kubernetes");
      expect(result.hits).toEqual([]);
      expect(result.relaxed).toBe(false);
      await close();
    });

    /**
     * The relaxed pass ranks by how many *distinct* terms a document matched, not by how densely one term
     * covers it. This pins the case that separates the two: `ts_rank_cd` scores the spammy document perfectly
     * and put it first, which is why the fallback uses `ts_rank`.
     */
    it("ranks a document matching more terms above one repeating a single term", async () => {
      const { db, mine, close } = await twoProjects();
      const many = await createItem(db, { projectId: mine.id, area: "DATA", title: "Many", body: "optional flag tool model" }, ACTOR);
      const spam = await createItem(db, { projectId: mine.id, area: "DATA", title: "Spam", body: "flag flag flag flag flag flag flag flag flag flag" }, ACTOR);

      // No document has all four terms, so this relaxes - which is where the ranker choice actually matters.
      const result = await search(db, mine.id, "optional flag tool model chooses");
      expect(result.relaxed).toBe(true);
      expect(result.hits.map((h) => h.ref)).toEqual([many.ref, spam.ref]);
      await close();
    });

    it("keeps a quoted phrase a phrase in the relaxed pass", async () => {
      const { db, mine, close } = await twoProjects();
      await createItem(db, { projectId: mine.id, area: "OPS", title: "Fly", body: "Scale to zero, and the machine sleeps." }, ACTOR);
      await createItem(db, { projectId: mine.id, area: "OPS", title: "Decoy", body: "Zero reason to scale anything here." }, ACTOR);

      // A phrase renders with `<->` rather than `&`, so it survives the rewrite intact - the decoy has both
      // words but not adjacent, and must not be dragged in when the rest of the query relaxes.
      const result = await search(db, mine.id, '"scale to zero" hibernation');
      expect(result.relaxed).toBe(true);
      expect(result.hits.map((h) => h.ref)).toEqual(["OPS-1"]);
      await close();
    });
  });
});
