/**
 * The property that makes the YAML trustworthy as the source of truth: export -> import -> export is
 * byte-identical, and a load faithfully restores the data (ids, timestamps, deps, nesting). If either broke,
 * committing the file or rebuilding from it would silently corrupt the plan.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb } from "../db/testing";
import { comments, dependencies, items, measurements } from "../db/schema";
import { one } from "../db/rows";
import { createItem, deleteItem, editItem } from "../domain/items";
import { createProject, listProjects, setDirection } from "../domain/projects";
import { uuidv7, timestamp } from "../db/ids";
import { ensureUser } from "../domain/users";
import { setSection } from "../domain/context";
import { addComment, MAX_BODY } from "../domain/comments";
import { getNext, setNext } from "../domain/next";
import { recordMeasurements } from "../domain/measurements";
import type { MeasurementRecord } from "./measurements";
import { YAML_FORMAT } from "./format";
import { parse, stringify } from "yaml";
import { adoptStore, asPlan, canonicalForms, createStoreFile, exportStore, ImportConflict, importStore, openStore, parseStore, resolveStorePath, resolveStorePaths, saveStore, stringifyStore } from "./store";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const ACTOR = "test";

/** A database with the full shape the serialiser must cover: a direction, several items, a nested child, and
 *  a dependency. Deps and nesting are inserted directly since those domain ops are not in the MVP yet. */
async function seed(db: Awaited<ReturnType<typeof freshDb>>["db"], ownerId: string) {
  const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
  await setDirection(db, p.id, "Ship the MVP", ACTOR);
  await setSection(db, { projectId: p.id, heading: "Goals", content: "ship it, then dogfood" }, ACTOR);
  await setSection(db, { projectId: p.id, heading: "Open questions", content: "split the journal files?" }, ACTOR);
  const mcp1 = await createItem(db, { projectId: p.id, area: "MCP", title: "server", body: "the stdio server" }, ACTOR);
  const mcp2 = await createItem(db, { projectId: p.id, area: "MCP", title: "tools", status: "in-progress" }, ACTOR);
  const data1 = await createItem(db, { projectId: p.id, area: "DATA", title: "storage", status: "done" }, ACTOR);
  // A nested child MCP-1.1 and a dependency MCP-2 -> DATA-1.
  await db.insert(items).values({
    id: "child-uuid",
    projectId: p.id,
    ref: "MCP-1.1",
    areaKey: "MCP",
    sortPath: "000001.000001",
    parentId: mcp1.id,
    title: "sub-task",
    status: "to-do",
    createdAt: mcp1.createdAt,
    updatedAt: mcp1.updatedAt,
  });
  await db.insert(dependencies).values({ itemId: mcp2.id, dependsOnId: data1.id, createdAt: mcp2.createdAt });
  // Comments of both audiences, one attached to an item and one not: the database is rebuilt from this file on
  // every start, so an unexported comment is a comment that does not survive a restart.
  await addComment(db, { projectId: p.id, body: "the stdio banner problem bit us again", itemId: mcp2.id }, ACTOR);
  // Direct insert, because `addComment` refuses a project-level comment since `CTX-15` - and the seed has
  // to keep one, since real stores hold them and the export must carry them or a restart loses them.
  await db.insert(comments).values({ projectId: p.id, itemId: null, body: "check whether sort_path needs widening", audience: "agent", actor: ACTOR });
  // An agreed order (PROJ-8), deliberately including the done item: the export is the durable copy, so it
  // carries what was stored, and the filtering of done items belongs to `getNext` on the read side.
  await setNext(db, p.id, ["MCP-2", "DATA-1"], ACTOR);
  return p;
}

describe("YAML store", () => {
  it("still loads a plan file written before `priority` was removed, and stops writing it (PROJ-8)", async () => {
    // Third instance of the same compatibility rule, after `sessions:` and `notes:`: a plan file is committed
    // history, so an older checkout has to keep loading, and there is no migration step to hang a conversion
    // off because the YAML *is* the database. The first export retires the key by itself.
    const { db, ownerId, close } = await freshDb();
    const store = parseStore(
      [
        "projects:",
        "  - key: apm",
        "    name: AI PM",
        "    type: software",
        "    status: active",
        "    id: p1",
        "    created_at: t",
        "    updated_at: t",
        "    areas: []",
        "    items:",
        "      - ref: MCP-1",
        "        area: MCP",
        "        title: server",
        "        status: to-do",
        "        sort_path: '000001'",
        "        priority: 7",
        "        id: i1",
        "        created_at: t",
        "        updated_at: t",
      ].join("\n"),
    );
    await importStore(db, store);
    const out = await exportStore(db, ownerId);
    expect(out.projects[0]?.items[0]?.ref).toBe("MCP-1");
    expect(stringifyStore(out)).not.toContain("priority");
    await close();
  });

  it("carries the agreed order as one line of refs, unfiltered (PROJ-8)", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await seed(db, ownerId);
    const store = await exportStore(db, ownerId);
    // The join table exports as a compact array in position order, exactly as `dependencies` exports as
    // `deps:`. Storage shape and serialisation shape are independent, which is what buys integrity and a
    // one-line diff at the same time.
    expect(store.projects[0]?.next).toEqual(["MCP-2", "DATA-1"]);
    expect(stringifyStore(store)).toContain("next:\n      - MCP-2\n      - DATA-1");
    // Stored is not shown: DATA-1 is done, so it never reaches a reader, but dropping it from the file would
    // make reopening the item silently lose its place.
    expect((await getNext(db, p.id)).map((n) => n.ref)).toEqual(["MCP-2"]);
    await close();
  });

  it("restores the order, and renumbers positions from the file (PROJ-8)", async () => {
    const a = await freshDb();
    await seed(a.db, a.ownerId);
    const store = await exportStore(a.db, a.ownerId);

    const b = await freshDb();
    const ownerId = (await ensureUser(b.db, { issuer: "local", subject: "local" })).id;
    await importStore(b.db, store);
    const restored = await exportStore(b.db, ownerId);
    expect(restored.projects[0]?.next).toEqual(["MCP-2", "DATA-1"]);
    await a.close();
    await b.close();
  });

  it("round-trips export -> import -> export byte-identical", async () => {
    const a = await freshDb();
    await seed(a.db, a.ownerId);
    const first = stringifyStore(await exportStore(a.db, a.ownerId));

    const b = await freshDb();
    await importStore(b.db, await exportStore(a.db, a.ownerId));
    const second = stringifyStore(await exportStore(b.db, b.ownerId));

    expect(second).toBe(first);
    await a.close();
    await b.close();
  });

  it("preserves ids, refs, nesting and dependencies through a load", async () => {
    const a = await freshDb();
    await seed(a.db, a.ownerId);
    const original = await exportStore(a.db, a.ownerId);

    const b = await freshDb();
    await importStore(b.db, original);
    const restored = await exportStore(b.db, b.ownerId);

    const project = restored.projects[0]!;
    expect(project.direction).toBe("Ship the MVP");
    expect(project.context).toEqual({ Goals: "ship it, then dogfood", "Open questions": "split the journal files?" });
    const refs = project.items.map((i) => i.ref);
    expect(refs).toEqual(["DATA-1", "MCP-1", "MCP-1.1", "MCP-2"]); // area then sort_path, parent before child
    expect(project.items.find((i) => i.ref === "MCP-1.1")?.parent).toBe("MCP-1");
    expect(project.items.find((i) => i.ref === "MCP-2")?.deps).toEqual(["DATA-1"]);
    // ids survive verbatim (identity is stable across a rebuild)
    expect(project.items.find((i) => i.ref === "MCP-1.1")?.id).toBe("child-uuid");
    // Comments survive, and each is written where it belongs: the item-attached one nests under its item, the
    // unattached one stays on the project. So reading the YAML shows a ticket beside what happened on it.
    expect(project.items.find((i) => i.ref === "MCP-2")?.comments?.map((n) => n.body)).toEqual(["the stdio banner problem bit us again"]);
    expect(project.items.find((i) => i.ref === "MCP-1")?.comments).toBeUndefined(); // absent, not an empty list
    expect(project.comments?.map((n) => ({ body: n.body, audience: n.audience }))).toEqual([
      { body: "check whether sort_path needs widening", audience: "agent" },
    ]);
    await a.close();
    await b.close();
  });

  it("holds several projects in one file, keyed and ordered by key", async () => {
    const a = await freshDb();
    await createProject(a.db, { key: "spanish", name: "Spanish", type: "learning", ownerId: a.ownerId }, ACTOR);
    await createProject(a.db, { key: "apm", name: "AI PM", type: "software", ownerId: a.ownerId }, ACTOR);
    await createItem(a.db, { projectId: (await createProject(a.db, { key: "plants", name: "Plants", type: "care", ownerId: a.ownerId }, ACTOR)).id, area: "WATER", title: "fiddle fig" }, ACTOR);

    const b = await freshDb();
    await importStore(b.db, await exportStore(a.db, a.ownerId));
    const restored = await exportStore(b.db, b.ownerId);

    // One store file is already multi-project: the schema is a list, so `create_project` just adds to it.
    expect(restored.projects.map((p) => p.key)).toEqual(["apm", "plants", "spanish"]);
    expect(restored.projects.find((p) => p.key === "plants")?.items.map((i) => i.ref)).toEqual(["WATER-1"]);
    await a.close();
    await b.close();
  });

  it("omits null fields so the YAML stays readable", async () => {
    const db = await freshDb();
    await createProject(db.db, { key: "bare", name: "Bare", type: "software", ownerId: db.ownerId }, ACTOR);
    const text = stringifyStore(await exportStore(db.db, db.ownerId));
    expect(text).not.toContain("direction:"); // null direction is absent, not `direction: null`
    expect(text).not.toContain("null");
    await db.close();
  });

  it("still loads a plan file written before sessions were removed (CTX-10)", async () => {
    // A plan file is committed history, so checking out or pulling a branch from before the removal must not
    // fail to parse. The key is accepted and dropped: nothing reads it, and nothing writes it back, so the
    // first export after a load quietly retires it. This is the compatibility hazard IMP-14 is about, and it
    // is cheap to guard and expensive to discover.
    const db = await freshDb();
    const legacy = `projects:
  - key: apm
    name: AI PM
    type: software
    status: active
    id: ${uuidv7()}
    created_at: ${timestamp()}
    updated_at: ${timestamp()}
    areas: []
    items: []
    sessions:
      - summary: built the schema
        started_at: ${timestamp()}
        actor: claude
`;
    await importStore(db.db, parseStore(legacy));
    const restored = one((await exportStore(db.db, db.ownerId)).projects);
    expect(restored.key).toBe("apm");
    expect(restored.sessions).toBeUndefined(); // accepted on the way in, never written back out
    await db.close();
  });

  it("loads a plan file that still says `notes:`, and writes it back as `comments:` (CTX-2)", async () => {
    // Both keys are read, indefinitely: the YAML *is* the database, so there is no migration step to hang a
    // conversion off, and an older branch or a colleague's pull has to keep loading. Only `comments:` is
    // written, so a file converts itself the first time anything writes to it.
    const db = await freshDb();
    const legacy = `projects:
  - key: apm
    name: AI PM
    type: software
    status: active
    id: ${uuidv7()}
    created_at: ${timestamp()}
    updated_at: ${timestamp()}
    areas: []
    items: []
    notes:
      - body: written before the rename
        audience: user
        id: ${uuidv7()}
        at: ${timestamp()}
        actor: claude
`;
    await importStore(db.db, parseStore(legacy));
    const restored = one((await exportStore(db.db, db.ownerId)).projects);
    expect(restored.comments?.map((c) => c.body)).toEqual(["written before the rename"]);
    expect(restored.notes).toBeUndefined(); // read on the way in, never written back out
    await db.close();
  });

  it("does not enforce the comment length cap on import (CTX-2)", async () => {
    // The cap governs what is *written* from here on. Enforcing it on load would make the 64 long comments
    // written before the rename unloadable, which would turn a house rule into a corrupt store.
    const db = await freshDb();
    const essay = "x".repeat(MAX_BODY * 3);
    const legacy = `projects:
  - key: apm
    name: AI PM
    type: software
    status: active
    id: ${uuidv7()}
    created_at: ${timestamp()}
    updated_at: ${timestamp()}
    areas: []
    items: []
    comments:
      - body: ${essay}
        audience: user
        id: ${uuidv7()}
        at: ${timestamp()}
        actor: claude
`;
    await importStore(db.db, parseStore(legacy));
    const restored = one((await exportStore(db.db, db.ownerId)).projects);
    expect(restored.comments?.[0]?.body).toHaveLength(essay.length);
    await db.close();
  });
});

describe("opening the store", () => {
  it("creates an empty file on a first run, then loads it rather than recreating", async () => {
    const dir = await mkdtemp(join(tmpdir(), "apm-store-"));
    const path = join(dir, "nested", "project.apm.yaml"); // nested: the parent directory is created too

    const first = await freshDb();
    expect((await openStore(first.db, path)).created).toBe(true);
    expect(existsSync(path)).toBe(true); // the location is knowable before anything is written to it
    await createProject(first.db, { key: "apm", name: "AI PM", type: "software", ownerId: first.ownerId }, ACTOR);
    await saveStore(first.db, path);
    await first.close();

    const second = await freshDb();
    expect((await openStore(second.db, path)).created).toBe(false); // found, so loaded, not clobbered
    expect((await exportStore(second.db, second.ownerId)).projects.map((p) => p.key)).toEqual(["apm"]);
    await second.close();

    await rm(dir, { recursive: true, force: true });
  });
});

describe("resolving the store path", () => {
  const home = join(homedir(), ".ai-project-manager", "project.apm.yaml");

  it("treats a blank or unsubstituted override as unset", () => {
    // Both arrive from the .mcpb manifest, which wires APM_STORE_PATH to an optional user_config field: an
    // unfilled field is an empty string, and a host that failed to substitute would pass the placeholder
    // through verbatim. Acting on either would try to create a nonsense file at cwd `/` under launchd, kill
    // the server on boot, and look to the user like "the tools did not appear".
    for (const override of ["", "   ", "${user_config.store_path}"]) {
      expect(resolveStorePath(override)).not.toContain("$");
      expect(resolveStorePath(override)).not.toBe(override);
    }
    expect(resolveStorePath("/tmp/plan.apm.yaml")).toBe("/tmp/plan.apm.yaml"); // a real path still wins
  });

  it("discovers every plan file beside it, because a split plan is two files in one repo (IMP-17)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "apm-discover-"));
    await writeFile(join(dir, "roadmap.apm.yaml"), "projects: []\n");
    await writeFile(join(dir, "cloud.apm.yaml"), "projects: []\n");
    await writeFile(join(dir, "notes.txt"), "not a store");
    const cwd = process.cwd;
    process.cwd = () => dir;
    try {
      // Picking one of them was the old behaviour, and it served half a plan without saying so.
      expect(resolveStorePaths()).toEqual([join(dir, "cloud.apm.yaml"), join(dir, "roadmap.apm.yaml")]);
    } finally {
      process.cwd = cwd;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the home directory when there is nothing to discover", () => {
    // The Claude Desktop condition: launchd starts it at `/`, so the tree walk finds nothing.
    const cwd = process.cwd;
    process.cwd = () => "/";
    try {
      expect(resolveStorePath("")).toBe(home);
    } finally {
      process.cwd = cwd;
    }
  });
});

describe("asPlan (VIEW-15)", () => {
  it("keeps deleted items in the export and drops them from the plan", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await seed(db, ownerId);
    await deleteItem(db, { projectId: p.id, ref: "DATA-1" }, ACTOR);

    // The export is the durable copy: losing the row would resurrect the ticket on the next rebuild, and
    // IMP-8 fails the build on a column the YAML does not carry.
    const exported = one((await exportStore(db, ownerId)).projects);
    expect(exported.items.find((i) => i.ref === "DATA-1")?.deleted_at).toBeDefined();

    // The feed is for rendering, and a deleted ticket drawn on the graph is a ticket that looks like work.
    const plan = one(asPlan(await exportStore(db, ownerId)).projects);
    expect(plan.items.map((i) => i.ref)).not.toContain("DATA-1");
    expect(plan.items.every((i) => i.deleted_at === undefined)).toBe(true);
    // and the edge that pointed at it goes with it, so nothing draws an arrow into empty space
    expect(plan.items.find((i) => i.ref === "MCP-2")?.deps ?? []).toEqual([]);
    await close();
  });

  it("strips references to a dropped item rather than trusting them to be absent", async () => {
    // deleteItem does remove the edges, so this is defence against a hand-edited or merged file - a
    // projection that renders an edge to a node it did not include is a drawing bug, not a data one.
    const { db, ownerId, close } = await freshDb();
    await seed(db, ownerId); // only for the project shell the projection is applied to
    const plan = asPlan({
      projects: [
        {
          ...one((await exportStore(db, ownerId)).projects),
          items: [
            { ref: "MCP-1", area: "MCP", title: "live", status: "to-do", sort_path: "000001", priority: 0, id: "a", created_at: "t", updated_at: "t", deps: ["GONE-1"] },
            { ref: "MCP-2", area: "MCP", title: "orphan", status: "to-do", sort_path: "000002", priority: 0, id: "b", created_at: "t", updated_at: "t", parent: "GONE-1" },
            { ref: "GONE-1", area: "GONE", title: "deleted", status: "to-do", sort_path: "000001", priority: 0, id: "c", created_at: "t", updated_at: "t", deleted_at: "t" },
          ],
        },
      ],
    });
    const items = one(plan.projects).items;
    expect(items.find((i) => i.ref === "MCP-1")?.deps).toEqual([]);
    expect(items.find((i) => i.ref === "MCP-2")?.parent).toBeUndefined();
    expect(items.map((i) => i.ref)).toEqual(["MCP-1", "MCP-2"]);
    await close();
  });
});

describe("refusing a stale write (IMP-13)", () => {
  /** A store file with one project in it, and a StoreFile that has loaded it. */
  async function opened() {
    const dir = await mkdtemp(join(tmpdir(), "apm-stale-"));
    const path = join(dir, "plan.apm.yaml");
    const { db, ownerId, close } = await freshDb();
    const store = createStoreFile(path);
    await store.open(db);
    await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await store.save(db);
    return { dir, path, db, ownerId, close, store };
  }

  it("reproduces the incident: the second writer refuses instead of destroying the first one's work", async () => {
    // 2026-07-30, two Claude Code windows on one repo. Window A created a ticket, which was written
    // correctly. Window B, holding a snapshot from before it, wrote the whole file back and the ticket
    // ceased to exist - with no error anywhere, and A still reporting it as present from memory.
    const a = await opened();

    // B is a second process that loaded the same file, then wrote its own work into it.
    const b = await freshDb();
    const bStore = createStoreFile(a.path);
    await bStore.open(b.db);
    const bProject = await createProject(b.db, { key: "other", name: "B's project", type: "software", ownerId: b.ownerId }, ACTOR);
    await createItem(b.db, { projectId: bProject.id, area: "HOST", title: "B's ticket" }, ACTOR);
    await bStore.save(b.db);

    // A now writes. Before this fix it succeeded and erased everything above.
    const aProject = one(await listProjects(a.db, a.ownerId));
    await createItem(a.db, { projectId: aProject.id, area: "DAW", title: "A's ticket" }, ACTOR);
    await expect(a.store.save(a.db)).rejects.toThrow(/refusing to save/);

    // B's work survived, which is the whole point.
    const onDisk = parseStore(await readFile(a.path, "utf8"));
    expect(onDisk.projects.map((p) => p.key)).toEqual(["apm", "other"]);
    expect(onDisk.projects.find((p) => p.key === "other")?.items.map((i) => i.title)).toEqual(["B's ticket"]);

    await a.close();
    await b.close();
    await rm(a.dir, { recursive: true, force: true });
  });

  it("says the change was applied but not saved, since the database is now ahead of the file", async () => {
    const a = await opened();
    await writeFile(a.path, "projects: []\n");
    await expect(a.store.save(a.db)).rejects.toThrow(/applied in memory but NOT saved/);
    // and refuses again rather than recovering: a process that cannot write cannot clobber
    await expect(a.store.save(a.db)).rejects.toThrow(/refusing to save/);
    await a.close();
    await rm(a.dir, { recursive: true, force: true });
  });

  it("treats the file being deleted underneath as a conflict, not as a first run", async () => {
    const a = await opened();
    await rm(a.path);
    await expect(a.store.save(a.db)).rejects.toThrow(/has been deleted since this server loaded it/);
    await a.close();
    await rm(a.dir, { recursive: true, force: true });
  });

  it("saves repeatedly without complaint when nothing else touches the file", async () => {
    // The guard tracks its own writes, so the common case - one server, many mutations - is unaffected.
    const a = await opened();
    const project = one(await listProjects(a.db, a.ownerId));
    for (const title of ["one", "two", "three"]) {
      await createItem(a.db, { projectId: project.id, area: "MCP", title }, ACTOR);
      await a.store.save(a.db);
    }
    expect(parseStore(await readFile(a.path, "utf8")).projects[0]!.items).toHaveLength(3);
    await a.close();
    await rm(a.dir, { recursive: true, force: true });
  });

  it("is fine on a first run, where it created the file itself", async () => {
    const dir = await mkdtemp(join(tmpdir(), "apm-stale-"));
    const path = join(dir, "plan.apm.yaml");
    const { db, ownerId, close } = await freshDb();
    const store = createStoreFile(path);
    expect((await store.open(db)).created).toBe(true);
    await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await expect(store.save(db)).resolves.toBeUndefined();
    await close();
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * `/api/store` is the viewer's whole read surface, so an unscoped export is the entire plan world-readable the
 * moment that route is served publicly (`VIEW-24`). Locally it could not matter - one person, one file, a
 * loopback port - which is exactly why it went unnoticed until the server was hosted.
 */
describe("exporting is scoped to an owner (VIEW-24)", () => {
  it("leaves another owner's projects out entirely", async () => {
    const { db, ownerId, close } = await freshDb();
    const other = await ensureUser(db, { issuer: "https://idp.example/auth/v1", subject: "sub-other" });
    await createProject(db, { key: "mine", name: "Mine", type: "software", ownerId }, ACTOR);
    await createProject(db, { key: "theirs", name: "Theirs", type: "software", ownerId: other.id }, ACTOR);

    expect((await exportStore(db, ownerId)).projects.map((p) => p.key)).toEqual(["mine"]);
    expect((await exportStore(db, other.id)).projects.map((p) => p.key)).toEqual(["theirs"]);
    await close();
  });

  it("exports nothing for an owner with nothing, rather than everything", async () => {
    const { db, ownerId, close } = await freshDb();
    await createProject(db, { key: "mine", name: "Mine", type: "software", ownerId }, ACTOR);
    const stranger = await ensureUser(db, { issuer: "https://idp.example/auth/v1", subject: "sub-stranger" });
    // The failure that matters is a filter that silently degrades to "no filter" for an unknown owner.
    expect((await exportStore(db, stranger.id)).projects).toEqual([]);
    await close();
  });
});

describe("importing a plan file into a shared database (VIEW-24)", () => {
  /** The smallest thing the schema accepts, with its own id - which is what a real uploaded file carries. */
  const project = (key: string) => ({
    key,
    name: key,
    type: "learning",
    status: "active",
    id: uuidv7(),
    created_at: timestamp(),
    updated_at: timestamp(),
    areas: [],
    items: [],
  });
  const planWith = (key: string) => parseStore(stringifyStore({ projects: [project(key)] }));

  it("adopts a store under the caller, leaving other owners alone", async () => {
    const { db, ownerId, close } = await freshDb();
    const other = await ensureUser(db, { issuer: "https://idp.example/auth/v1", subject: "sub-other" });
    await createProject(db, { key: "theirs", name: "Theirs", type: "software", ownerId: other.id }, ACTOR);

    expect((await adoptStore(db, ownerId, planWith("spanish"))).keys).toEqual(["spanish"]);
    expect((await listProjects(db, ownerId)).map((p) => p.key)).toEqual(["spanish"]);
    // Ownership is never read from the file - only from who uploaded it.
    expect((await listProjects(db, other.id)).map((p) => p.key)).toEqual(["theirs"]);
    await close();
  });

  it("refuses a key the caller already uses, and says which", async () => {
    const { db, ownerId, close } = await freshDb();
    await createProject(db, { key: "spanish", name: "Spanish", type: "learning", ownerId }, ACTOR);
    await expect(adoptStore(db, ownerId, planWith("spanish"))).rejects.toThrow(/already have a project called "spanish"/);
    await close();
  });

  it("does not refuse a key that only another owner uses", async () => {
    const { db, ownerId, close } = await freshDb();
    const other = await ensureUser(db, { issuer: "https://idp.example/auth/v1", subject: "sub-other" });
    await createProject(db, { key: "spanish", name: "Theirs", type: "learning", ownerId: other.id }, ACTOR);
    // Refusing here would also disclose that someone else has a project by that name.
    expect((await adoptStore(db, ownerId, planWith("spanish"))).keys).toEqual(["spanish"]);
    await close();
  });

  it("refuses the same file twice, rather than colliding on ids", async () => {
    const { db, ownerId, close } = await freshDb();
    const plan = planWith("spanish");
    await adoptStore(db, ownerId, plan);
    await expect(adoptStore(db, ownerId, plan)).rejects.toThrow(/already have a project called "spanish"/);
    await close();
  });

  it("raises a conflict the caller can answer, naming the keys (OPS-19.3)", async () => {
    const { db, ownerId, close } = await freshDb();
    await createProject(db, { key: "spanish", name: "Spanish", type: "learning", ownerId }, ACTOR);
    // A distinct type, because the route turns this one refusal into "overwrite spanish?" and every other
    // into an error message. A string match on the wording would be the thing that quietly stops working.
    const conflict = await adoptStore(db, ownerId, planWith("spanish")).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ImportConflict);
    expect((conflict as ImportConflict).keys).toEqual(["spanish"]);
    await close();
  });

  it("replaces the caller's copy when asked, keeping the key and taking the file's rows (OPS-19.3)", async () => {
    const { db, ownerId, close } = await freshDb();
    const mine = await createProject(db, { key: "spanish", name: "Spanish", type: "learning", ownerId }, ACTOR);
    await createItem(db, { projectId: mine.id, area: "VOCAB", title: "only in the old copy" }, ACTOR);

    const incoming = planWith("spanish");
    const { keys, replaced } = await adoptStore(db, ownerId, incoming, { replace: true });
    expect(keys).toEqual(["spanish"]);
    expect(replaced).toEqual(["spanish"]);

    // The file wins entirely: one project by that key, and the item that was only in the old copy is gone.
    const after = (await exportStore(db, ownerId)).projects;
    expect(after.map((p) => p.key)).toEqual(["spanish"]);
    expect(after[0]?.items).toEqual([]);
    // The *file's* id, not the replaced project's - which is what makes a round trip exact rather than a
    // lookalike wearing the same key.
    expect(after[0]?.id).toBe(incoming.projects[0]?.id);
    await close();
  });

  it("will not replace a project id another owner holds, even with replace asked for", async () => {
    const { db, ownerId, close } = await freshDb();
    const other = await ensureUser(db, { issuer: "https://idp.example/auth/v1", subject: "sub-other" });
    const plan = planWith("spanish");
    await adoptStore(db, other.id, plan);
    // Owner scoping exists to stop exactly this: `replace` is an answer about the caller's own data, never a
    // licence to delete a row because the id in a file happens to match it.
    await expect(adoptStore(db, ownerId, plan, { replace: true })).rejects.toThrow(/id is already in use/);
    expect((await listProjects(db, other.id)).map((p) => p.key)).toEqual(["spanish"]);
    await close();
  });

  it("does not touch a stranger's project that happens to share the key", async () => {
    const { db, ownerId, close } = await freshDb();
    const other = await ensureUser(db, { issuer: "https://idp.example/auth/v1", subject: "sub-other" });
    const theirs = await createProject(db, { key: "spanish", name: "Theirs", type: "learning", ownerId: other.id }, ACTOR);
    await createItem(db, { projectId: theirs.id, area: "VOCAB", title: "theirs, and it stays theirs" }, ACTOR);
    await createProject(db, { key: "spanish", name: "Mine", type: "learning", ownerId }, ACTOR);

    // Keys are unique *per owner*, so two accounts legitimately both have a `spanish`. The clash set is built
    // from the caller's own rows only, and this is the test that it stays that way: a replace scoped by key
    // alone would delete a stranger's project for having picked the same obvious name.
    await adoptStore(db, ownerId, planWith("spanish"), { replace: true });
    const after = await exportStore(db, other.id);
    expect(after.projects.map((p) => p.key)).toEqual(["spanish"]);
    expect(after.projects[0]?.items.map((i) => i.title)).toEqual(["theirs, and it stays theirs"]);
    await close();
  });

  it("leaves the caller's other projects alone, down to their rows", async () => {
    const { db, ownerId, close } = await freshDb();
    const keep = await createProject(db, { key: "plants", name: "Plants", type: "generic", ownerId }, ACTOR);
    const item = await createItem(db, { projectId: keep.id, area: "CARE", title: "water the fern" }, ACTOR);
    await addComment(db, { projectId: keep.id, body: "it is looking rough", itemId: item.id }, ACTOR);
    await recordMeasurements(db, { projectId: keep.id, itemId: item.id, at: "2026-09-01T08:00:00.000Z", readings: [{ metric: "height", value: 30, unit: "cm" }] }, ACTOR);
    await createProject(db, { key: "spanish", name: "Spanish", type: "learning", ownerId }, ACTOR);

    // The delete is one statement over an id list, and the cascades reach a long way - items, comments,
    // context, measurements, events. The failure this guards is that list being wrong by one project.
    await adoptStore(db, ownerId, planWith("spanish"), { replace: true });

    const after = (await exportStore(db, ownerId)).projects.find((p) => p.key === "plants");
    expect(after?.items.map((i) => i.title)).toEqual(["water the fern"]);
    expect(after?.items[0]?.comments?.map((c) => c.body)).toEqual(["it is looking rough"]);
    expect(await db.select().from(measurements)).toHaveLength(1);
    await close();
  });

  it("leaves a scoped dependency in another project pointing at the replaced one (PROJ-11)", async () => {
    const { db, ownerId, close } = await freshDb();
    const core = await createProject(db, { key: "core", name: "Core", type: "software", ownerId }, ACTOR);
    const cloud = await createProject(db, { key: "cloud", name: "Cloud", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: core.id, area: "DIST", title: "the licence" }, ACTOR);
    await createItem(db, { projectId: cloud.id, area: "OPS", title: "packaging" }, ACTOR);
    await editItem(db, { projectId: cloud.id, ref: "OPS-1", deps: ["core:DIST-1"] }, ACTOR);

    // The claim `adoptStore` makes in its own doc comment, measured rather than asserted: a scoped edge
    // stores `(key, ref)` as text on the *dependent* item, so deleting the project it points at cannot
    // cascade into it. Replacing half a split plan therefore never dangles an edge in the other half.
    await adoptStore(db, ownerId, parseStore(stringifyStore({ projects: [{ ...project("core"), id: core.id }] })), { replace: true });

    const after = (await exportStore(db, ownerId)).projects.find((p) => p.key === "cloud");
    expect(after?.items.find((i) => i.ref === "OPS-1")?.deps).toEqual(["core:DIST-1"]);
    await close();
  });

  it("carries measurements in, and a replace restores them from the bundle rather than dropping them", async () => {
    const { db, ownerId, close } = await freshDb();
    const plan = planWith("health");
    const reading = (id: string, at: string): MeasurementRecord => ({
      id,
      project: "health",
      metric: "weight",
      value: 80,
      unit: "kg",
      at,
      actor: ACTOR,
      created_at: at,
    });

    await adoptStore(db, ownerId, plan, { measurements: [reading(uuidv7(), "2026-09-01T08:00:00.000Z")] });
    expect(await db.select().from(measurements)).toHaveLength(1);

    // The point of putting measurements in the bundle: a project delete cascades to them (schema.ts), so a
    // replace that carried only the plan would silently destroy every reading recorded here.
    const second = reading(uuidv7(), "2026-09-02T08:00:00.000Z");
    const result = await adoptStore(db, ownerId, plan, { replace: true, measurements: [second] });
    expect(result.measurements).toEqual({ loaded: 1, skipped: 0 });
    expect((await db.select().from(measurements)).map((row) => row.id)).toEqual([second.id]);
    await close();
  });

  it("leaves the database untouched when it refuses", async () => {
    const { db, ownerId, close } = await freshDb();
    await createProject(db, { key: "spanish", name: "Spanish", type: "learning", ownerId }, ACTOR);
    const two = parseStore(stringifyStore({ projects: [project("plants"), project("spanish")] }));
    await expect(adoptStore(db, ownerId, two)).rejects.toThrow();
    // One transaction, so the project that would have been fine does not land either - a half-imported store
    // is worse than a refused one, because nothing says which half.
    expect((await listProjects(db, ownerId)).map((p) => p.key)).toEqual(["spanish"]);
    await close();
  });
});

describe("picking up an external change (IMP-10)", () => {
  /** The refs a database currently holds, which is what "did the reload happen" reduces to. */
  const refsIn = async (db: Awaited<ReturnType<typeof freshDb>>["db"], ownerId: string) =>
    (await exportStore(db, ownerId)).projects.flatMap((p) => p.items.map((i) => i.ref));

  /** A store file seeded through the full shape, and a StoreFile that has loaded and written it. */
  async function opened() {
    const dir = await mkdtemp(join(tmpdir(), "apm-reload-"));
    const path = join(dir, "plan.apm.yaml");
    const { db, ownerId, close } = await freshDb();
    const store = createStoreFile(path);
    await store.open(db);
    const project = await seed(db, ownerId);
    await store.save(db);
    return { dir, path, db, ownerId, store, project, done: async () => (await close(), rm(dir, { recursive: true, force: true })) };
  }

  /** Whatever `path` holds now, as the plan. */
  const onDisk = async (path: string) => parseStore(await readFile(path, "utf8"));

  it("rebuilds from the file when something else writes it, which is the git-pull case", async () => {
    const a = await opened();

    // A second process - the other Claude Code window, or `git pull` landing a branch - edits the plan.
    const b = await freshDb();
    const bStore = createStoreFile(a.path);
    await bStore.open(b.db);
    const bProject = one(await listProjects(b.db, b.ownerId));
    await createItem(b.db, { projectId: bProject.id, area: "IMP", title: "arrived from elsewhere" }, ACTOR);
    await bStore.save(b.db);

    // A has not been told, and until it reads it does not know.
    expect(await refsIn(a.db, a.ownerId)).not.toContain("IMP-1");

    expect(await a.store.refresh(a.db)).toBe(true);
    expect(await refsIn(a.db, a.ownerId)).toContain("IMP-1");

    await b.close();
    await a.done();
  });

  it("says nothing happened when nothing did, including after its own write", async () => {
    // The common case by far, and the one that must stay free: one server, many mutations, no reload.
    const a = await opened();
    expect(await a.store.refresh(a.db)).toBe(false);

    await createItem(a.db, { projectId: a.project.id, area: "MCP", title: "ours" }, ACTOR);
    await a.store.save(a.db);
    // Our own write moved the mtime. It must not read as a foreign change, or every mutation would be
    // followed by a pointless rebuild and a notice telling the user their plan changed underneath them.
    expect(await a.store.refresh(a.db)).toBe(false);
    expect(await refsIn(a.db, a.ownerId)).toContain("MCP-3");

    await a.done();
  });

  it("clears what the new file does not have, rather than merging the two", async () => {
    // The reload is a replacement: rows from the old plan that the new one dropped must go, across every
    // table. A merge would resurrect a ticket someone deleted on another branch - silently, and only in the
    // one process that had it loaded.
    const a = await opened();
    await writeFile(a.path, stringifyStore({ projects: [{ ...one(await onDisk(a.path).then((s) => s.projects)), items: [], comments: undefined, context: undefined }] }));

    expect(await a.store.refresh(a.db)).toBe(true);
    const after = one((await exportStore(a.db, a.ownerId)).projects);
    expect(after.items).toEqual([]);
    expect(after.comments).toBeUndefined();
    expect(after.context).toBeUndefined();

    await a.done();
  });

  it("leaves the loaded plan intact when the new file does not parse, and keeps saying so", async () => {
    // A half-written file, or a merge conflict left in place. Serving the last good plan is recoverable;
    // serving an empty one is not - and the complaint has to repeat, because a server that reported the
    // problem once and then answered normally from a plan it could not re-read is the worst of both.
    const a = await opened();
    await writeFile(a.path, "projects:\n  - key: apm\n    <<<<<<< HEAD\n");

    await expect(a.store.refresh(a.db)).rejects.toThrow();
    expect(await refsIn(a.db, a.ownerId)).toContain("MCP-1");
    await expect(a.store.refresh(a.db)).rejects.toThrow();

    await a.done();
  });

  it("does not treat a deleted file as an instruction to empty the plan", async () => {
    // Checking out a branch from before the plan existed must not wipe it. There is nothing to load, so
    // there is nothing to do; `save` still refuses, so nothing gets written over whatever did it.
    const a = await opened();
    await rm(a.path);

    expect(await a.store.refresh(a.db)).toBe(false);
    expect(await refsIn(a.db, a.ownerId)).toContain("MCP-1");
    await expect(a.store.save(a.db)).rejects.toThrow(/has been deleted/);

    await a.done();
  });

  it("recovers the two-writer case: refresh first, and the save that used to be refused now lands", async () => {
    // The IMP-13 guard turned a silent clobber into a refusal, which left the process wedged until someone
    // reconnected it. This is the ending: the next call reloads, so the work goes on top of the other
    // window's rather than over it.
    const a = await opened();

    const b = await freshDb();
    const bStore = createStoreFile(a.path);
    await bStore.open(b.db);
    await createItem(b.db, { projectId: one(await listProjects(b.db, b.ownerId)).id, area: "IMP", title: "B's ticket" }, ACTOR);
    await bStore.save(b.db);

    await a.store.refresh(a.db);
    await createItem(a.db, { projectId: a.project.id, area: "DAW", title: "A's ticket" }, ACTOR);
    await expect(a.store.save(a.db)).resolves.toBeUndefined();

    const refs = (await onDisk(a.path)).projects.flatMap((p) => p.items.map((i) => i.ref));
    expect(refs).toContain("IMP-1"); // B's, kept
    expect(refs).toContain("DAW-1"); // A's, added

    await b.close();
    await a.done();
  });

});

describe("overlapping writes to one file (IMP-15)", () => {
  /** A loaded store with a project in it, and the tool layer's two side effects bound to it. */
  async function loaded() {
    const dir = await mkdtemp(join(tmpdir(), "apm-concurrent-"));
    const path = join(dir, "plan.apm.yaml");
    const { db, ownerId, close } = await freshDb();
    const store = createStoreFile(path);
    await store.open(db);
    const project = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    await store.save(db);
    return { path, db, store, project, done: async () => { await close(); await rm(dir, { recursive: true, force: true }); } };
  }

  /** The refs actually written to the file, which is the only thing that says the plan is durable. */
  async function refsOnDisk(path: string): Promise<string[]> {
    const parsed = parseStore(await readFile(path, "utf8"));
    return (parsed.projects[0]?.items ?? []).map((item) => item.ref).sort();
  }

  it("persists every one of a batch of parallel creates, and reports no failures", async () => {
    // The shape Claude Code actually produces: "create five tickets" arrives as five overlapping tool calls,
    // each ending in its own persist. Before IMP-15 four of the five rejected with
    // `ENOENT: rename plan.apm.yaml.tmp -> plan.apm.yaml`, because every save wrote one shared scratch file
    // and the first rename consumed it.
    const s = await loaded();

    const made = await Promise.all(
      Array.from({ length: 5 }, async (_, n) => {
        const item = await createItem(s.db, { projectId: s.project.id, area: "ZZ", title: `parallel ${n}` }, ACTOR);
        await s.store.save(s.db);
        return item.ref;
      }),
    );

    expect(new Set(made).size).toBe(5);
    // The assertion that matters. Checking only that the calls resolved is what let this survive: the in-memory
    // database was always right, and the file was the thing left behind.
    expect(await refsOnDisk(s.path)).toEqual(["ZZ-1", "ZZ-2", "ZZ-3", "ZZ-4", "ZZ-5"]);
    await s.done();
  });

  it("survives saves and refreshes interleaved, reporting no foreign change", async () => {
    // `guarded` refreshes before every tool call and persists after, so under parallel calls the two interleave
    // constantly. This pins the observable outcome: the file ends correct and no refresh claims someone else
    // wrote it.
    //
    // **What this test does NOT prove**, stated plainly because the name used to overclaim it. The hazard that
    // motivated putting `refresh` inside the queue is a narrow race: between a save's `rename` and its
    // bookkeeping, the file on disk is new while `known` still holds the previous hash, so a refresh landing in
    // exactly that window calls it a foreign edit and rebuilds the database from a snapshot that predates any
    // insert committed since. Measured 2026-08-09: with the queue removed but the per-writer temp name kept,
    // this test still passes. The window is a single `stat` wide and cannot be hit reliably without a seam
    // injected purely to slow it down. The queue is kept on the argument, not on this test, and the argument is
    // that the cost is one promise chain against a silent dropped ticket.
    const s = await loaded();

    const reloads = await Promise.all(
      Array.from({ length: 6 }, async (_, n) => {
        // Alternating, so a refresh is always queued behind or between saves rather than after all of them.
        if (n % 2 === 0) {
          await createItem(s.db, { projectId: s.project.id, area: "ZZ", title: `interleaved ${n}` }, ACTOR);
          await s.store.save(s.db);
          return false;
        }
        return s.store.refresh(s.db);
      }),
    );

    // Nothing else touched the file, so no refresh may claim it changed. A true here is the database having
    // been cleared and rebuilt underneath the writes.
    expect(reloads).not.toContain(true);
    expect(await refsOnDisk(s.path)).toEqual(["ZZ-1", "ZZ-2", "ZZ-3"]);
    await s.done();
  });

  it("leaves no scratch files behind", async () => {
    // The temp name is now per-writer, so a leaked one would accumulate rather than be overwritten next time.
    const s = await loaded();
    await Promise.all(
      Array.from({ length: 4 }, async (_, n) => {
        await createItem(s.db, { projectId: s.project.id, area: "ZZ", title: `leak check ${n}` }, ACTOR);
        await s.store.save(s.db);
      }),
    );

    const left = (await readdir(dirname(s.path))).filter((name) => name.endsWith(".tmp"));
    expect(left).toEqual([]);
    await s.done();
  });
});

/**
 * A plan spread across several files (`IMP-17`). The runtime holds the union of them, and the thing that has
 * to hold is that a mutation reaches exactly one file: the whole reason to split a plan is that the two halves
 * live in different repos, and a write that touched both would put every edit in both git histories.
 */
describe("a plan spread across several files (IMP-17)", () => {
  /** A store file on disk holding one project, written exactly the way the server writes one. */
  async function planFile(path: string, key: string): Promise<void> {
    const { db, ownerId, close } = await freshDb();
    const store = createStoreFile(path);
    await store.open(db);
    await createProject(db, { key, name: key, type: "software", ownerId }, ACTOR);
    await store.save(db);
    await close();
  }

  /** Two plan files, side by side as they will be in this repo, with a store set loaded over both. */
  async function split(dirs: { apart?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "apm-split-"));
    const second = dirs.apart === true ? await mkdtemp(join(tmpdir(), "apm-split-b-")) : dir;
    const core = join(dir, "core.apm.yaml");
    const cloud = join(second, "cloud.apm.yaml");
    await planFile(core, "core");
    await planFile(cloud, "cloud");
    const { db, ownerId, close } = await freshDb();
    const store = createStoreFile([core, cloud]);
    await store.open(db);
    return {
      dir,
      second,
      core,
      cloud,
      db,
      ownerId,
      store,
      async done() {
        await close();
        await rm(dir, { recursive: true, force: true });
        await rm(second, { recursive: true, force: true });
      },
    };
  }

  it("loads every file into one runtime, so both plans are queryable at once", async () => {
    const s = await split();
    expect((await listProjects(s.db, s.ownerId)).map((p) => p.key).sort()).toEqual(["cloud", "core"]);
    await s.done();
  });

  it("rewrites only the file whose plan changed, leaving the other's bytes untouched", async () => {
    const s = await split();
    const before = await readFile(s.cloud, "utf8");

    const core = one((await listProjects(s.db, s.ownerId)).filter((p) => p.key === "core"));
    await createItem(s.db, { projectId: core.id, area: "DOM", title: "only core's" }, ACTOR);
    await s.store.save(s.db);

    // The point of the split: an edit to one half is not a diff in the other half's repo.
    expect(await readFile(s.cloud, "utf8")).toBe(before);
    expect(await readFile(s.core, "utf8")).toContain("only core's");
    await s.done();
  });

  it("keeps each file to its own projects rather than writing the union into both", async () => {
    const s = await split();
    const core = one((await listProjects(s.db, s.ownerId)).filter((p) => p.key === "core"));
    await createItem(s.db, { projectId: core.id, area: "DOM", title: "only core's" }, ACTOR);
    await s.store.save(s.db);

    expect(parseStore(await readFile(s.core, "utf8")).projects.map((p) => p.key)).toEqual(["core"]);
    expect(parseStore(await readFile(s.cloud, "utf8")).projects.map((p) => p.key)).toEqual(["cloud"]);
    await s.done();
  });

  it("puts a project created at runtime in the primary file, since nothing named one", async () => {
    const s = await split();
    await createProject(s.db, { key: "third", name: "third", type: "software", ownerId: s.ownerId }, ACTOR);
    await s.store.save(s.db);

    expect(parseStore(await readFile(s.core, "utf8")).projects.map((p) => p.key)).toEqual(["core", "third"]);
    expect(parseStore(await readFile(s.cloud, "utf8")).projects.map((p) => p.key)).toEqual(["cloud"]);
    await s.done();
  });

  it("picks up an external change to any of the files, not just the first", async () => {
    const s = await split();

    // A second process edits the *second* file, as a `git pull` in the other checkout would.
    const other = await freshDb();
    const otherStore = createStoreFile(s.cloud);
    await otherStore.open(other.db);
    const theirs = one(await listProjects(other.db, other.ownerId));
    await createItem(other.db, { projectId: theirs.id, area: "OPS", title: "added elsewhere" }, ACTOR);
    await otherStore.save(other.db);
    await other.close();

    expect(await s.store.refresh(s.db)).toBe(true);
    const cloud = one((await listProjects(s.db, s.ownerId)).filter((p) => p.key === "cloud"));
    const titles = await s.db.select({ title: items.title }).from(items).where(eq(items.projectId, cloud.id));
    expect(titles.map((t) => t.title)).toEqual(["added elsewhere"]);
    // and the file that did not move still has its project: a reload rebuilds from the union, not from one file
    expect((await listProjects(s.db, s.ownerId)).map((p) => p.key).sort()).toEqual(["cloud", "core"]);

    // The reloaded plan still writes back to the right file.
    await s.store.save(s.db);
    expect(parseStore(await readFile(s.core, "utf8")).projects.map((p) => p.key)).toEqual(["core"]);
    await s.done();
  });

  it("refuses two files that hold the same project, by name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "apm-clash-"));
    const first = join(dir, "first.apm.yaml");
    const second = join(dir, "second.apm.yaml");
    await planFile(first, "apm");
    // The plausible mistake: copy a plan file to start a second one and forget to re-key it.
    await writeFile(second, await readFile(first, "utf8"));

    const { db, close } = await freshDb();
    await expect(createStoreFile([first, second]).open(db)).rejects.toThrow(/both hold project key "apm"/);
    await close();
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a shared measurements directory once, however many plan files sit in it", async () => {
    const s = await split();
    const reading = (project: string): MeasurementRecord => ({
      id: uuidv7(),
      project,
      metric: "weight",
      value: 80,
      unit: "kg",
      at: "2026-01-02T00:00:00.000Z",
      actor: ACTOR,
      created_at: "2026-01-02T00:00:00.000Z",
    });
    await s.store.appendMeasurements([reading("core"), reading("cloud")]);

    // Both files are in one directory, so both would read the same month file: the readings must not double.
    const again = await freshDb();
    const againStore = createStoreFile([s.core, s.cloud]);
    await againStore.open(again.db);
    expect((await again.db.select().from(measurements)).length).toBe(2);
    await again.close();
    await s.done();
  });

  it("routes a reading to the file that owns its project, when the files are in different places", async () => {
    const s = await split({ apart: true });
    await s.store.appendMeasurements([
      {
        id: uuidv7(),
        project: "cloud",
        metric: "weight",
        value: 80,
        unit: "kg",
        at: "2026-01-02T00:00:00.000Z",
        actor: ACTOR,
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(existsSync(join(s.second, ".apm", "measurements"))).toBe(true);
    expect(existsSync(join(s.dir, ".apm", "measurements"))).toBe(false);
    await s.done();
  });
});

/** `--store` is repeatable and `APM_STORE_PATH` takes a list, which is how a split plan is named (`IMP-17`). */
describe("resolving several store paths (IMP-17)", () => {
  it("keeps the given order, because the first is the primary", () => {
    expect(resolveStorePaths(["/tmp/a.apm.yaml", "/tmp/b.apm.yaml"])).toEqual(["/tmp/a.apm.yaml", "/tmp/b.apm.yaml"]);
  });

  it("splits an environment variable on the platform delimiter", () => {
    const previous = process.env.APM_STORE_PATH;
    process.env.APM_STORE_PATH = ["/tmp/a.apm.yaml", "/tmp/b.apm.yaml"].join(delimiter);
    try {
      expect(resolveStorePaths()).toEqual(["/tmp/a.apm.yaml", "/tmp/b.apm.yaml"]);
    } finally {
      if (previous === undefined) delete process.env.APM_STORE_PATH;
      else process.env.APM_STORE_PATH = previous;
    }
  });

  it("drops the unusable entries rather than resolving to a file named after a placeholder", () => {
    expect(resolveStorePaths(["${user_config.store_path}", "/tmp/real.apm.yaml"])).toEqual(["/tmp/real.apm.yaml"]);
  });

  it("still answers with one path when nothing was named, so the ordinary case is unchanged", () => {
    expect(resolveStorePaths(["/tmp/only.apm.yaml"])).toEqual(["/tmp/only.apm.yaml"]);
    expect(resolveStorePath("/tmp/only.apm.yaml")).toBe("/tmp/only.apm.yaml");
  });
});

/**
 * A dependency naming another project has to survive the file (`PROJ-11`), including the case the plan split
 * exists for: an edge into a project this checkout does not have.
 */
describe("a dependency naming another project round-trips (PROJ-11)", () => {
  async function split() {
    const { db, ownerId, close } = await freshDb();
    const core = await createProject(db, { key: "core", name: "Core", type: "software", ownerId }, ACTOR);
    const cloud = await createProject(db, { key: "cloud", name: "Cloud", type: "software", ownerId }, ACTOR);
    await createItem(db, { projectId: core.id, area: "DIST", title: "the licence" }, ACTOR);
    await createItem(db, { projectId: cloud.id, area: "OPS", title: "packaging" }, ACTOR);
    await editItem(db, { projectId: cloud.id, ref: "OPS-1", deps: ["core:DIST-1", "nowhere:X-1"] }, ACTOR);
    return { db, ownerId, close };
  }

  it("exports into `deps:` beside the local refs, and survives a reload unchanged", async () => {
    const source = await split();
    const first = stringifyStore(await exportStore(source.db, source.ownerId));
    // The colon needs no quoting: YAML wants colon-*space* to read a mapping, so this is a plain scalar.
    // Asserted rather than assumed, because the whole format rests on it.
    expect(first).toContain("- core:DIST-1");

    const reloaded = await freshDb();
    await importStore(reloaded.db, parseStore(first));
    expect(stringifyStore(await exportStore(reloaded.db, reloaded.ownerId))).toBe(first);

    await source.close();
    await reloaded.close();
  });

  it("keeps the scoped refs even when only one of the two projects is loaded", async () => {
    const source = await split();
    const whole = await exportStore(source.db, source.ownerId);
    await source.close();

    // What a clone of the public repo holds: one store file, and edges pointing at a project it has never
    // seen. Both scoped refs must load, including the one that *could* have resolved in the full runtime.
    const alone = { projects: whole.projects.filter((p) => p.key === "cloud") };
    const one = await freshDb();
    await importStore(one.db, alone);
    const exported = await exportStore(one.db, one.ownerId);
    expect(exported.projects[0]?.items[0]?.deps).toEqual(["core:DIST-1", "nowhere:X-1"]);
    await one.close();
  });

  it("is not stripped by the plan projection, which drops references to items that are not there", async () => {
    const source = await split();
    const whole = await exportStore(source.db, source.ownerId);
    await source.close();
    // `asPlan` removes deps naming no live item, which is every scoped ref by definition - keeping them is
    // what lets the viewer draw the placeholder (VIEW-15 plus PROJ-11).
    const plan = asPlan({ projects: whole.projects.filter((p) => p.key === "cloud") });
    expect(plan.projects[0]?.items[0]?.deps).toEqual(["core:DIST-1", "nowhere:X-1"]);
  });
});

/**
 * One layout for every writer, and a way to tell when a file is not in it (`IMP-19`).
 *
 * The export was always deterministic; what broke sync-shaped diffs was a file reaching git in some *other*
 * layout - a hand edit, a find-and-replace rename - which the next save then rewrote wholesale. These prove
 * the two halves of the fix: prose keeps its own line breaks, so a hand edit is not re-flowed; and a file
 * that does not match what a save would write is detectable before it is committed.
 */
describe("one layout for every writer (IMP-19)", () => {
  it("stores a body exactly as written, so a newline stays one newline", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const body = "A first line\nwrapped by hand.\n\nSecond paragraph.\n\n- one\n- two";
    await createItem(db, { projectId: p.id, area: "MCP", title: "server", body }, ACTOR);
    const text = stringifyStore(await exportStore(db, ownerId));

    // A literal block, not a folded one: the folded style reads a single newline as a space, so it had to
    // double every real one to keep it - the mid-sentence blank lines `IMP-11` was filed about.
    expect(text).toContain("body: |-");
    expect(text).toMatch(/A first line\n\s*wrapped by hand\./);
    expect(text).toMatch(/- one\n\s*- two/);
    expect(parseStore(text).projects[0]?.items[0]?.body).toBe(body);
    await close();
  });

  it("never re-wraps a long paragraph, so editing one word changes one line", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const long = "word ".repeat(60).trim();
    await createItem(db, { projectId: p.id, area: "MCP", title: "server", body: long }, ACTOR);
    const before = stringifyStore(await exportStore(db, ownerId));
    await editItem(db, { projectId: p.id, ref: "MCP-1", body: long.replace("word", "WORD") }, ACTOR);
    const after = stringifyStore(await exportStore(db, ownerId));

    // Folded at 80 columns, this paragraph spanned four lines and a change near the start could reflow all
    // of them. Unfolded, it is one line, so exactly the one line holding the edit - plus `updated_at`.
    const changed = after.split("\n").filter((line, index) => line !== before.split("\n")[index]);
    expect(changed).toHaveLength(2);
    expect(changed[0]).toContain("WORD word word");
    await close();
  });

  /** A seeded plan saved to disk the way the server saves it, then loaded back into a fresh runtime. */
  async function savedAndReloaded() {
    const dir = await mkdtemp(join(tmpdir(), "apm-canonical-"));
    const path = join(dir, "plan.apm.yaml");
    const source = await freshDb();
    const project = await seed(source.db, source.ownerId);
    // Prose long enough to wrap and with real newlines in it, because that is where the two layouts differ:
    // the seed's short bodies come out the same either way, which would let the folded case pass vacuously.
    const prose = `${"a paragraph long enough to wrap at eighty columns ".repeat(4).trim()}\nand a hand wrap.\n\n- one\n- two`;
    await createItem(source.db, { projectId: project.id, area: "DATA", title: "long prose", body: prose }, ACTOR);
    await saveStore(source.db, path);
    await source.close();
    const text = await readFile(path, "utf8");
    return { dir, path, text };
  }

  async function formsOf(files: { path: string; text: string }[]) {
    const { db, close } = await freshDb();
    const loaded = files.map(({ path, text }) => ({ path, store: parseStore(text) }));
    for (const { store } of loaded) await importStore(db, store);
    const forms = await canonicalForms(db, loaded);
    await close();
    return forms;
  }

  it("calls a file the save path wrote canonical", async () => {
    const { dir, path, text } = await savedAndReloaded();
    // The property the check rests on, and the one sync needs: a file a save wrote is a file the next save
    // leaves alone, so an export differs from it only by what actually changed.
    expect((await formsOf([{ path, text }])).get(path)).toBe(text);
    await rm(dir, { recursive: true });
  });

  it("does not call the old folded layout canonical", async () => {
    const { dir, path, text } = await savedAndReloaded();
    // What every store committed before this change looks like, so this is the case the one-time `--fix`
    // exists for - and the case that would otherwise surface as a whole-file diff at the next save.
    const folded = stringify(parse(text));
    expect(folded).not.toBe(text);
    expect((await formsOf([{ path, text: folded }])).get(path)).toBe(text);
    await rm(dir, { recursive: true });
  });

  it("does not call items out of order canonical, which a hand-added ticket usually is", async () => {
    const { dir, path, text } = await savedAndReloaded();
    // Six hand-added tickets in a real plan went in newest-first; the exporter sorts by `sort_path`. Same data,
    // different file - exactly the drift that is invisible in review and loud at the next save.
    const store = parse(text);
    store.projects[0].items.reverse();
    const shuffled = stringify(store, YAML_FORMAT);
    expect((await formsOf([{ path, text: shuffled }])).get(path)).toBe(text);
    await rm(dir, { recursive: true });
  });

  it("gives each file of a split plan only its own projects", async () => {
    const one = await savedAndReloaded();
    // A second file with a different project, so the two partitions are distinguishable.
    const other = await freshDb();
    await createProject(other.db, { key: "cloud", name: "Cloud", type: "software", ownerId: other.ownerId }, ACTOR);
    const otherPath = join(one.dir, "cloud.apm.yaml");
    await saveStore(other.db, otherPath);
    await other.close();
    const otherText = await readFile(otherPath, "utf8");

    const forms = await formsOf([{ path: one.path, text: one.text }, { path: otherPath, text: otherText }]);
    // The same partition `saveStore` uses when writing a split plan (`IMP-17`), so a canonical file of one
    // half never contains the other half's projects.
    expect(forms.get(one.path)).toBe(one.text);
    expect(forms.get(otherPath)).toBe(otherText);
    await rm(one.dir, { recursive: true });
  });
});
