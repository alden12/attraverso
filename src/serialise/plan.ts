/**
 * The plan as data: the YAML schema, and the round trip between it and the database (`exportStore`, `importStore`,
 * `parseStore`, `stringifyStore`). Everything about *where* a plan lives - paths, discovery, atomic writes, the
 * stale-write guard - stays in `store.ts`. The split is `DIST-6`'s: nothing here imports Node, so the in-process
 * library can open a plan in a browser, and `store.ts` re-exports all of it so no existing import moves.
 *
 * The two rules that make the YAML trustworthy are in `store.ts`'s header, and hold for every function here.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { parse, stringify } from "yaml";
import { clearAll, type Database, type Tx } from "../db/client";
import { areas, attachments, comments, contextSections, dependencies, items, layoutPositions, projectNext, projects, scopedDependencies } from "../db/schema";
import { ensureUserIn, LOCAL_IDENTITY } from "../domain/users";
import { loadMeasurements, type MeasurementRecord } from "./measurementRecords";
import { NOT_ACTIONABLE } from "../domain/next";
import { YAML_FORMAT } from "./format";
import { splitScope } from "../../scripts/tickets";

const areaSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().optional(),
  colour: z.string().optional(),
  sort_order: z.number(),
  id: z.string(),
  created_at: z.string(),
});

// Comments are written **where they belong**: a comment about a ticket nests under that ticket's `comments:`,
// and only project-level ones sit in the project's own list. Reading the file directly then shows a ticket
// and what was said about it together, rather than making the reader join a flat list back up by ref - the
// same reason context sections are a heading map rather than a table.
//
// A comment carries its `id`: comments can be edited and deleted, and are addressed by the tail of that id,
// so regenerating it on load would break every reference the moment the server restarts - which, since the
// database is rebuilt from this file on every start, is constantly.
const commentSchema = z.object({
  body: z.string(),
  audience: z.string(),
  id: z.string(),
  at: z.string(),
  actor: z.string(),
});

/** An attachment carries only the reference: the hash is the blob's identity and the bytes live under
 *  `.apm/media/`. Putting them here instead would end deterministic diffs and could not survive a rebuild. */
const attachmentSchema = z.object({
  hash: z.string(),
  mime: z.string(),
  bytes: z.number(),
  caption: z.string().optional(),
  id: z.string(),
  at: z.string(),
  actor: z.string(),
});

const itemSchema = z.object({
  ref: z.string(),
  area: z.string(),
  title: z.string(),
  status: z.string(),
  sort_path: z.string(),
  /**
   * Accepted for old plan files, never written (`PROJ-8`). It was an integer read by nothing, and the
   * ordered `next` list is what actually answers the question it was there for - a global priority over
   * 159 items cannot be maintained, and it conflates *important* with *next*. Kept parseable rather than
   * deleted, for the same reason `sessions:` and `notes:` are: a plan file is committed history, and an
   * older checkout has to keep loading. The first export retires the key by itself.
   */
  priority: z.number().optional(),
  parent: z.string().optional(),
  deps: z.array(z.string()).optional(),
  /** Planned dates, `YYYY-MM-DD` (`CAL-1`). Not validated here: the importer restores rows rather than
   *  judging them, so a hand-edited date loads and `edit_item` is where it gets corrected. */
  start: z.string().optional(),
  due: z.string().optional(),
  body: z.string().optional(),
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().optional(),
  deleted_at: z.string().optional(),
  comments: z.array(commentSchema).optional(),
  /** Accepted for old plan files, never written: see `readComments` (CTX-2). */
  notes: z.array(commentSchema).optional(),
  attachments: z.array(attachmentSchema).optional(),
  // The graph layout's memory (`VIEW-23.1`): node id -> "x,y", relative to the node's container. Last in the
  // project, and one line per node sorted by id, so a moved card is a one-line diff below everything a reviewer
  // reads, and the file stays the one place a project's map is shared from.
  layout: z.record(z.string(), z.string().regex(/^-?\d+,-?\d+$/, "a layout position is \"x,y\" in whole numbers")).optional(),
});

// Sessions were removed with the concept (CTX-10). The key stays *parseable* rather than being deleted,
// because a plan file is committed history: checking out a branch from before the removal, or pulling one,
// must still load. Zod strips unknown keys silently, so this is belt and braces - but the belt is what stops
// someone later switching the schema to `.strict()` and turning every old checkout into a parse error.
// Deliberately not typed field-by-field: nothing reads it, and describing a shape we no longer honour would
// invite someone to start honouring it again.
const retiredSessionSchema = z.array(z.unknown());


const projectSchema = z.object({
  key: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  direction: z.string().optional(),
  // The agreed work order (`PROJ-8`), as item refs. A join table underneath (`project_next`, with real
  // foreign keys), one readable line here - exactly as `dependencies` exports as `deps:`. Storage shape and
  // serialisation shape are independent, which is what lets integrity and a one-line diff both hold.
  next: z.array(z.string()).optional(),
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  archived_at: z.string().optional(),
  // Context sections as a readable heading -> content map. Identity is the heading (unique per project), so
  // no id or timestamps ride along - they read as prose and stay stable across a round trip. Insertion order
  // is the display order, which YAML preserves.
  context: z.record(z.string(), z.string()).optional(),
  areas: z.array(areaSchema),
  items: z.array(itemSchema),
  // Accepted and ignored, never written: see `retiredSessionSchema` (CTX-10).
  sessions: retiredSessionSchema.optional(),
  // Comments (CTX-2). Must be exported or they are lost: the database is rebuilt from this file on every
  // start, so anything not written here does not survive a restart.
  comments: z.array(commentSchema).optional(),
  /** Accepted for old plan files, never written: see `readComments` (CTX-2). */
  notes: z.array(commentSchema).optional(),
  attachments: z.array(attachmentSchema).optional(),
  // The graph layout's memory (`VIEW-23.1`): node id -> "x,y", relative to the node's container. Last in the
  // project, and one line per node sorted by id, so a moved card is a one-line diff below everything a reviewer
  // reads, and the file stays the one place a project's map is shared from.
  layout: z.record(z.string(), z.string().regex(/^-?\d+,-?\d+$/, "a layout position is \"x,y\" in whole numbers")).optional(),
});

/**
 * Comments under either key, because they were `notes:` until 2026-09-01 (`CTX-2`).
 *
 * **Both are accepted indefinitely, and only `comments:` is written.** A plan file is committed history: a
 * checkout of an older branch, or a colleague's pull, has to keep loading, and there is no migration step to
 * hang a conversion off - the YAML *is* the database. The first export after a load quietly retires the old
 * key, so a file converts itself the first time anything writes to it.
 *
 * Both present would mean a hand-merged file or a half-finished edit. Concatenating is the safe reading:
 * ids are preserved on import, so a row appearing under both keys would collide on the primary key and fail
 * loudly rather than silently keeping one copy.
 */
const readComments = (owner: { comments?: Comment[]; notes?: Comment[] }): Comment[] => [...(owner.comments ?? []), ...(owner.notes ?? [])];

type Comment = z.infer<typeof commentSchema>;

const storeSchema = z.object({ projects: z.array(projectSchema) });

export type Store = z.infer<typeof storeSchema>;

/**
 * The store as a *plan*, with soft-deleted items and every reference to them removed (VIEW-15).
 *
 * The export keeps deleted rows because it is the durable copy: `deleted_at` has to round-trip or a restart
 * would resurrect a deleted ticket, and `IMP-8` fails the build on a column the YAML does not carry. A feed
 * for rendering wants the opposite, and conflating the two is why `/api/store` was shipping deleted tickets
 * with their full bodies - the viewer maps whatever it is given, so they drew on the graph as live work.
 *
 * "A deleted ticket still resolves by ref" is a lookup guarantee, which `get_ticket` provides against the
 * database. It was never a reason to put them in the graph feed.
 *
 * References to a dropped item are stripped rather than trusted to be absent. `deleteItem` does remove
 * dependency edges in both directions and refuses a parent with live children, so today there is nothing to
 * strip - but this file can also be hand-edited or merged, and a projection whose correctness depends on an
 * invariant enforced somewhere else is one refactor from drawing an edge to a node that is not there.
 */
export function asPlan(store: Store): Store {
  return {
    projects: (store.projects ?? []).map((project) => {
      const live = (project.items ?? []).filter((item) => item.deleted_at === undefined);
      const present = new Set(live.map((item) => item.ref));
      // The agreed order carries only *actionable* items - the same `NOT_ACTIONABLE` rule `getNext` applies on
      // the read side (`PROJ-8`), imported rather than restated so the viewer and the pack cannot disagree
      // about what is next. Filtered for display and never cleaned up on write, so reopening an item restores
      // its place. It belongs here rather than in the viewer, because this is already the projection that
      // strips references to dropped items.
      const actionable = new Set(live.filter((item) => !NOT_ACTIONABLE.includes(item.status)).map((item) => item.ref));
      return {
        ...project,
        next: project.next?.filter((ref) => actionable.has(ref)),
        items: live.map((item) => ({
          ...item,
          // A scoped ref (`PROJ-11`) names an item in another project, so `present` never holds it: keeping it
          // is the point, since an unresolved edge is what the viewer draws as a placeholder.
          deps: item.deps?.filter((ref) => splitScope(ref) !== null || present.has(ref)),
          parent: item.parent !== undefined && present.has(item.parent) ? item.parent : undefined,
        })),
      };
    }),
  };
}

/** Drop a null/empty optional so it is omitted from the YAML entirely (undefined is skipped by stringify). */
const opt = <T>(value: T | null | undefined): T | undefined => (value === null || value === undefined ? undefined : value);

export async function exportStore(db: Database, ownerId: string): Promise<Store> {
  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.ownerId, ownerId))
    .orderBy(asc(projects.key));
  const out: Store = { projects: [] };

  for (const p of projectRows) {
    const areaRows = await db.select().from(areas).where(eq(areas.projectId, p.id)).orderBy(asc(areas.key));
    const itemRows = await db
      .select()
      .from(items)
      .where(eq(items.projectId, p.id))
      .orderBy(asc(items.areaKey), asc(items.sortPath));

    const idToRef = new Map(itemRows.map((i) => [i.id, i.ref]));
    const depRows = await db
      .select({ itemId: dependencies.itemId, dependsOnId: dependencies.dependsOnId })
      .from(dependencies)
      .innerJoin(items, eq(dependencies.itemId, items.id))
      .where(eq(items.projectId, p.id));
    const scopedDepRows = await db
      .select({ itemId: scopedDependencies.itemId, project: scopedDependencies.targetProject, ref: scopedDependencies.targetRef })
      .from(scopedDependencies)
      .innerJoin(items, eq(scopedDependencies.itemId, items.id))
      .where(eq(items.projectId, p.id));

    const depsByRef = new Map<string, string[]>();
    for (const d of depRows) {
      const ref = idToRef.get(d.itemId);
      const dependsOn = idToRef.get(d.dependsOnId);
      if (ref === undefined || dependsOn === undefined) continue;
      (depsByRef.get(ref) ?? depsByRef.set(ref, []).get(ref)!).push(dependsOn);
    }
    // Written into the same `deps:` list rather than a key of their own: a scoped ref is a dependency that
    // happens to name a project, and a second key would make every reader handle two shapes of one idea.
    for (const d of scopedDepRows) {
      const ref = idToRef.get(d.itemId);
      if (ref === undefined) continue;
      (depsByRef.get(ref) ?? depsByRef.set(ref, []).get(ref)!).push(`${d.project}:${d.ref}`);
    }

    // Position order, not sorted: here the order *is* the data, unlike `deps`, which is sorted for a stable
    // diff because a dependency set has no meaningful order of its own.
    const nextRows = await db
      .select({ ref: items.ref })
      .from(projectNext)
      .innerJoin(items, eq(projectNext.itemId, items.id))
      .where(eq(projectNext.projectId, p.id))
      .orderBy(asc(projectNext.position));

    const sectionRows = await db
      .select()
      .from(contextSections)
      .where(eq(contextSections.projectId, p.id))
      .orderBy(asc(contextSections.sortOrder), asc(contextSections.heading));
    const context: Record<string, string> = {};
    for (const s of sectionRows) context[s.heading] = s.content;

    // Ordered by (created_at, body) so the round trip is byte-identical regardless of insertion order, then
    // split: item-attached comments go out under their item, the rest under the project.
    const commentRows = await db.select().from(comments).where(eq(comments.projectId, p.id)).orderBy(asc(comments.createdAt), asc(comments.body));
    const commentsByItem = new Map<string, typeof commentRows>();
    const projectComments: typeof commentRows = [];
    for (const n of commentRows) {
      if (n.itemId === null) projectComments.push(n);
      else (commentsByItem.get(n.itemId) ?? commentsByItem.set(n.itemId, []).get(n.itemId)!).push(n);
    }
    // Same treatment as comments: a stable order so the round trip is byte-identical, then split by whether the
    // attachment hangs off an item.
    const attachmentRows = await db
      .select()
      .from(attachments)
      .where(eq(attachments.projectId, p.id))
      .orderBy(asc(attachments.createdAt), asc(attachments.hash));
    const attachmentsByItem = new Map<string, typeof attachmentRows>();
    const projectAttachments: typeof attachmentRows = [];
    for (const a of attachmentRows) {
      if (a.itemId === null) projectAttachments.push(a);
      else (attachmentsByItem.get(a.itemId) ?? attachmentsByItem.set(a.itemId, []).get(a.itemId)!).push(a);
    }
    const fmtAttachments = (rows: typeof attachmentRows) =>
      rows.length > 0
        ? rows.map((a) => ({ hash: a.hash, mime: a.mime, bytes: a.bytes, caption: opt(a.caption), id: a.id, at: a.createdAt, actor: a.actor }))
        : undefined;

    const layoutRows = await db.select().from(layoutPositions).where(eq(layoutPositions.projectId, p.id)).orderBy(asc(layoutPositions.node));

    const fmtComments = (rows: typeof commentRows) =>
      rows.length > 0 ? rows.map((n) => ({ body: n.body, audience: n.audience, id: n.id, at: n.createdAt, actor: n.actor })) : undefined;

    out.projects.push({
      key: p.key,
      name: p.name,
      type: p.type,
      status: p.status,
      direction: opt(p.direction),
      next: nextRows.length > 0 ? nextRows.map((row) => row.ref) : undefined,
      id: p.id,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      archived_at: opt(p.archivedAt),
      context: sectionRows.length > 0 ? context : undefined,
      comments: fmtComments(projectComments),
      attachments: fmtAttachments(projectAttachments),
      areas: areaRows.map((a) => ({
        key: a.key,
        name: a.name,
        description: opt(a.description),
        colour: opt(a.colour),
        sort_order: a.sortOrder,
        id: a.id,
        created_at: a.createdAt,
      })),
      items: itemRows.map((i) => {
        const deps = depsByRef.get(i.ref);
        return {
          ref: i.ref,
          area: i.areaKey,
          title: i.title,
          status: i.status,
          sort_path: i.sortPath,
          parent: i.parentId ? opt(idToRef.get(i.parentId)) : undefined,
          deps: deps && deps.length > 0 ? [...deps].sort() : undefined,
          // Above the body, beside the other one-line fields, so a dated item reads its dates before its prose.
          start: opt(i.startOn),
          due: opt(i.dueOn),
          body: opt(i.body),
          id: i.id,
          created_at: i.createdAt,
          updated_at: i.updatedAt,
          closed_at: opt(i.closedAt),
          deleted_at: opt(i.deletedAt),
          comments: fmtComments(commentsByItem.get(i.id) ?? []),
          attachments: fmtAttachments(attachmentsByItem.get(i.id) ?? []),
        };
      }),
      layout: layoutRows.length > 0 ? Object.fromEntries(layoutRows.map((row) => [row.node, `${row.x},${row.y}`])) : undefined,
    });
  }
  return out;
}

/** Rebuild a fresh database from a store. Not through the domain layer: this is a restore of exact rows
 *  (ids, timestamps, no new events), so identity and history survive. Expects an empty database. */
export async function importStore(db: Database, store: Store): Promise<void> {
  await db.transaction((tx) => insertStore(tx, store));
}

/**
 * A re-import of something the caller already has, refused so it can be confirmed and retried (`OPS-19.3`).
 *
 * Its own type because the route has to tell it from every other refusal: a malformed file is a dead end, but
 * this one has an answer the person can give, and the viewer turns it into "overwrite <key>?" rather than an
 * error message they can only read. `keys` is what that question names.
 */
export class ImportConflict extends Error {
  constructor(readonly keys: string[]) {
    super(
      keys.length === 1
        ? `you already have a project called "${keys[0] as string}"`
        : `you already have projects called ${keys.map((key) => `"${key}"`).join(", ")}`,
    );
    this.name = "ImportConflict";
  }
}

/**
 * Add a plan file to an existing database, owned by the caller (`VIEW-24`).
 *
 * Distinct from `importStore`, which rebuilds an empty database from the one file that owns it. This adds to a
 * populated one, so it has to answer questions that path never faces.
 *
 * **A key the caller already uses is refused**, rather than renamed. Keys are unique per owner, so a rename
 * would work - and would leave someone with two projects called nearly the same thing and no idea which is
 * which. Refusing is the answer they can act on.
 *
 * **A project id already present is refused the same way.** The YAML carries the id of every row, and
 * preserving them is what makes a round trip exact - but it also means uploading the same file twice
 * collides. Re-keying on import would silently end the property that the file and the database agree, so the
 * collision is surfaced instead.
 *
 * **`replace` is how the caller answers that**, after confirming (`OPS-19.3`). It deletes their copy and
 * inserts this one, which is a whole-project overwrite and not a merge: the file wins entirely. Two things
 * that overwrite is *right* about are worth stating, because they are what make it safe to offer at all -
 * ids are preserved by the file, so the rebuilt rows are the same rows rather than lookalikes; and a scoped
 * dependency in *another* project points at `(key, ref)` as text rather than a foreign key (`PROJ-11`), so
 * replacing one half of a split plan never dangles an edge in the other.
 *
 * **What overwrite destroys and cannot restore is the event log.** `IMP-7`'s `.apm/events.jsonl` is unbuilt,
 * so events live only in the database and no bundle carries them. Measurements *are* carried, so passing
 * them here is not optional politeness: a replace with an empty list is how a year of readings disappears
 * behind a routine-looking confirm.
 *
 * **The move is one-way.** Once a project is here the database is its source of truth; there is no
 * write-through in this mode, so the file that was uploaded is a stale copy from the first edit onwards.
 * Nothing enforces that - it is a fact about the mode, and the surface offering the upload should say it.
 */
export async function adoptStore(
  db: Database,
  ownerId: string,
  store: Store,
  options: { replace?: boolean; measurements?: MeasurementRecord[] } = {},
): Promise<{ keys: string[]; replaced: string[]; measurements: { loaded: number; skipped: number } }> {
  const { replace = false, measurements = [] } = options;
  return db.transaction(async (tx) => {
    // Ids are checked against every project in the database, not just the caller's, because they are globally
    // unique - a collision with a stranger's row is still a collision, and would surface as a constraint
    // violation with nothing readable in it. Keys are checked only against the caller's, because they are
    // unique per owner: another person having a project called `apm` is not a reason to refuse yours, and
    // saying so would disclose that they have one.
    const existing = await tx.select({ id: projects.id, key: projects.key, ownerId: projects.ownerId }).from(projects);
    const byId = new Map(existing.map((row) => [row.id, row]));
    const mine = new Map(existing.filter((row) => row.ownerId === ownerId).map((row) => [row.key, row]));

    const clashes = new Map<string, string>(); // project id to delete -> the key it is known by here
    for (const project of store.projects) {
      const sameId = byId.get(project.id);
      // A stranger holding this id is not something `replace` may act on: it is their data, and deleting it
      // is exactly the thing owner scoping exists to prevent. Refused in both modes, and phrased as the
      // collision it is rather than disclosing whose it is.
      if (sameId !== undefined && sameId.ownerId !== ownerId) {
        throw new Error(`"${project.key}" cannot be imported - its id is already in use here`);
      }
      if (sameId !== undefined) clashes.set(sameId.id, sameId.key);
      const sameKey = mine.get(project.key);
      if (sameKey !== undefined) clashes.set(sameKey.id, sameKey.key);
    }

    if (clashes.size > 0) {
      if (!replace) throw new ImportConflict([...new Set(clashes.values())].sort());
      // One statement, and the cascades do the rest: every table hanging off a project carries
      // `onDelete: "cascade"`, so items, comments, context, measurements and events go with it. Inside the
      // same transaction as the insert, so a file that fails to validate leaves the old copy untouched.
      await tx.delete(projects).where(inArray(projects.id, [...clashes.keys()]));
    }

    await insertStore(tx, store, ownerId);
    // After the plan, always: a measurement names its subject by item ref, so the items have to be there for
    // it to resolve (and a row that does not resolve is skipped rather than fatal - see `loadMeasurements`).
    const loaded = await loadMeasurements(tx, measurements);
    return { keys: store.projects.map((project) => project.key), replaced: [...new Set(clashes.values())].sort(), measurements: loaded };
  });
}

/**
 * Replace everything in the database with `store`: the reload path, for a file that changed under a running
 * server (IMP-10).
 *
 * Clear and insert in **one transaction**, so a store that fails to insert - a dangling ref in a hand edit, a
 * merge left half-resolved - leaves the loaded plan exactly as it was. A server still serving the last good
 * plan is a server someone can fix the file from; one holding an empty database is not.
 */
export async function replaceStore(db: Database, store: Store): Promise<void> {
  await db.transaction(async (tx) => {
    // Identity survives: `users` is not plan data, and the caller is holding an `ownerId` from before this.
    await clearAll(tx, { keepIdentity: true });
    await insertStore(tx, store);
  });
}

async function insertStore(tx: Tx, store: Store, owner?: string): Promise<void> {
  // Everything in a plan file belongs to one account, and never one named in the file: identity belongs to a
  // deployment, not to a plan, or a clone would import whoever committed it. File mode resolves the single
  // local account; `adoptStore` passes the caller's, which is the only difference between loading a store and
  // importing someone's (`VIEW-24`).
  const ownerId = owner ?? (await ensureUserIn(tx, LOCAL_IDENTITY)).id;
  for (const p of store.projects) {
    await tx.insert(projects).values({
      id: p.id,
      ownerId,
      key: p.key,
      name: p.name,
      type: p.type,
      direction: p.direction ?? null,
      status: p.status,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      archivedAt: p.archived_at ?? null,
    });

    if (p.areas.length > 0) {
      await tx.insert(areas).values(
        p.areas.map((a) => ({
          id: a.id,
          projectId: p.id,
          key: a.key,
          name: a.name,
          description: a.description ?? null,
          colour: a.colour ?? null,
          sortOrder: a.sort_order,
          createdAt: a.created_at,
        })),
      );
    }

    const refToId = new Map(p.items.map((i) => [i.ref, i.id]));
    // Inserted in `sort_path` order, so a parent (MCP-3, `000003`) always precedes its child (MCP-3.1,
    // `000003.000001`) - the parent's path is a prefix of the child's - and the self-referencing FK is
    // satisfied without deferral.
    //
    // **Sorted here rather than trusted from the file** (`IMP-19`). A file the exporter wrote is already in
    // this order, but a hand edit need not be - one real plan's hand-added tickets went in newest-first - and a
    // child listed above its parent made the whole file unloadable. That turned a cosmetic drift into an
    // outage, and it also meant `apm:check --fix`, which rewrites through this path, could not repair the
    // one kind of file it most needs to. Order in the file is layout; `apm:check` enforces it, this tolerates it.
    const inInsertOrder = [...p.items].sort((a, b) => (a.sort_path < b.sort_path ? -1 : a.sort_path > b.sort_path ? 1 : 0));
    for (const i of inInsertOrder) {
      await tx.insert(items).values({
        id: i.id,
        projectId: p.id,
        ref: i.ref,
        areaKey: i.area,
        sortPath: i.sort_path,
        parentId: i.parent ? (refToId.get(i.parent) ?? null) : null,
        title: i.title,
        body: i.body ?? null,
        status: i.status,
        createdAt: i.created_at,
        updatedAt: i.updated_at,
        closedAt: i.closed_at ?? null,
        deletedAt: i.deleted_at ?? null,
        startOn: i.start ?? null,
        dueOn: i.due ?? null,
      });
    }

    // Split by whether the ref names another project (`PROJ-11`). A scope naming *this* project is
    // normalised back to a local ref, matching `setDependencies`, so a file written by hand the long way
    // loads as the same graph as one written by the tools.
    const scopedInFile = new Map<string, { project: string; ref: string }[]>();
    const depValues = p.items.flatMap((i) =>
      (i.deps ?? []).flatMap((depRef) => {
        const itemId = refToId.get(i.ref);
        if (itemId === undefined) return [];
        const split = splitScope(depRef);
        if (split !== null && split.project !== p.key) {
          scopedInFile.set(itemId, [...(scopedInFile.get(itemId) ?? []), split]);
          return [];
        }
        const dependsOnId = refToId.get(split?.ref ?? depRef);
        if (dependsOnId === undefined) return [];
        // Dep rows carry a created_at not stored in YAML; use the dependent item's, so load stays Date-free
        // and deterministic (it is not exported, so it never affects the round trip anyway).
        return [{ itemId, dependsOnId, createdAt: i.created_at }];
      }),
    );
    if (depValues.length > 0) await tx.insert(dependencies).values(depValues);

    const scopedValues = [...scopedInFile].flatMap(([itemId, targets]) =>
      targets.map((target) => ({ itemId, targetProject: target.project, targetRef: target.ref, createdAt: p.created_at })),
    );
    if (scopedValues.length > 0) await tx.insert(scopedDependencies).values(scopedValues);

    // The agreed order, positions renumbered from the array so the file's order is the stored order. A ref
    // naming no item is skipped rather than refused, matching how `deps` handles the same hand-edit: the FK
    // would reject the row, and the plan file is a text file people merge.
    const nextValues = (p.next ?? []).flatMap((ref) => {
      const itemId = refToId.get(ref);
      return itemId === undefined ? [] : [itemId];
    });
    if (nextValues.length > 0) {
      await tx.insert(projectNext).values(nextValues.map((itemId, position) => ({ projectId: p.id, itemId, position })));
    }

    // The layout's memory, verbatim: nothing about a position refers to a row, so there is nothing to resolve.
    const layoutValues = Object.entries(p.layout ?? {}).map(([node, at]) => {
      const [x, y] = at.split(",").map(Number) as [number, number];
      return { projectId: p.id, node, x, y };
    });
    if (layoutValues.length > 0) await tx.insert(layoutPositions).values(layoutValues);

    // Context sections: identity is the heading, so id/timestamps are regenerated ($defaultFn); the map's
    // order becomes the sort_order.
    const contextEntries = Object.entries(p.context ?? {});
    if (contextEntries.length > 0) {
      await tx.insert(contextSections).values(
        contextEntries.map(([heading, content], index) => ({ projectId: p.id, heading, content, sortOrder: index })),
      );
    }

    // Comments come from two places: the project's own list, and nested under each item. The attachment is
    // positional in the YAML rather than a ref field, so there is nothing to resolve and nothing that can
    // dangle - an item's comments cascade with it.
    const commentValues = [
      ...readComments(p).map((c) => ({ comment: c, itemId: null as string | null })),
      ...p.items.flatMap((i) => readComments(i).map((c) => ({ comment: c, itemId: refToId.get(i.ref) ?? null }))),
    ];
    if (commentValues.length > 0) {
      // No `MAX_BODY` check here, deliberately (CTX-2): the cap governs what is written from now on, and
      // enforcing it on import would make the 64 long comments written before the rename unloadable.
      await tx.insert(comments).values(
        commentValues.map(({ comment, itemId }) => ({
          id: comment.id,
          projectId: p.id,
          itemId,
          body: comment.body,
          audience: comment.audience,
          actor: comment.actor,
          createdAt: comment.at,
        })),
      );
    }

    const attachmentValues = [
      ...(p.attachments ?? []).map((a) => ({ attachment: a, itemId: null as string | null })),
      ...p.items.flatMap((i) => (i.attachments ?? []).map((a) => ({ attachment: a, itemId: refToId.get(i.ref) ?? null }))),
    ];
    if (attachmentValues.length > 0) {
      await tx.insert(attachments).values(
        attachmentValues.map(({ attachment: a, itemId }) => ({
          id: a.id,
          projectId: p.id,
          itemId,
          hash: a.hash,
          mime: a.mime,
          bytes: a.bytes,
          caption: a.caption ?? null,
          actor: a.actor,
          createdAt: a.at,
        })),
      );
    }
  }
}

/** The plan as text, in the one layout every writer shares (`IMP-19`, see `format.ts`). */
export const stringifyStore = (store: Store): string => stringify(store, YAML_FORMAT);

export function parseStore(text: string): Store {
  return storeSchema.parse(parse(text));
}
