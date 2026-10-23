/**
 * The plan layer as YAML: the durable, human-readable, committable form of a project (IMP-3/4). After the
 * storage pivot this is the *source of truth* - the in-memory PGlite database is rebuilt from it on load
 * (`importStore`) and written back on every mutation (`saveStore`). SQLite is gone; nothing here is a second
 * query engine, only a serialisation of the same rows.
 *
 * Two rules make it trustworthy:
 *
 * - **Deterministic.** Projects by key, areas by key, items by (area, sort_path), deps sorted; timestamps
 *   verbatim; nothing re-derived. So a one-field change is a one-line diff and committing it is meaningful.
 *   `importStore(export)` then `exportStore` round-trips byte-identical (proved in the test).
 * - **Readable, but stable.** Items reference each other by human ref (`parent: MCP-3`, `deps: [DATA-1]`),
 *   which reads well in a diff, while the uuid rides along as `id` so identity survives a rename. On load
 *   the refs are resolved back to ids.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { isStoreFile, LEGACY_STORE_SUFFIX, STORE_FILE } from "./paths";
import { parse, stringify } from "yaml";
import { clearAll, type Database, type Tx } from "../db/client";
import { areas, attachments, comments, contextSections, dependencies, items, projectNext, projects, scopedDependencies } from "../db/schema";
import { ensureUser, ensureUserIn, LOCAL_IDENTITY } from "../domain/users";
import { appendMeasurements, loadMeasurements, measurementsDirFor, readMeasurements, type MeasurementRecord } from "./measurements";
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


/**
 * Where the project's YAML lives (IMP-5, repo file mode). In precedence:
 *   1. `explicit` (the server's `--store` CLI arg) or `APM_STORE_PATH` - a file path, absolute or relative to
 *      the working directory. This names the file, so a project can be `spanish.yaml`, anywhere.
 *   2. the nearest `attraverso.yaml` (or legacy `*.apm.yaml`, `IMP-20`) found by walking up from the working
 *      directory - a repo-embedded project, committed at the repo root. Auto-discovery like tsconfig/yarn.lock,
 *      so there is usually nothing to specify.
 *   3. the home dir - a personal project (a language, houseplants) with no repo to live in.
 * A missing file at the resolved path is a first run, handled by `openStore`, not an error here.
 *
 * The primary store, when there are several (`IMP-17`): see `resolveStorePaths`.
 */
export function resolveStorePath(explicit?: string): string {
  const [primary] = resolveStorePaths(explicit === undefined ? undefined : [explicit]);
  return primary;
}

/**
 * Every store file to load, primary first (`IMP-17`).
 *
 * One file already holds many projects, so this is not how a second project is added - it is how a project's
 * plan comes from a *different place*, which is what `DIST-3`'s split needs: the open core's plan in the
 * public repo, the commercial plan in the private one, both open at once or the tool is worse at managing
 * its own project than it was before.
 *
 * **Primary is the first entry, and it is where a new project lands**, since `create_project` names no file.
 * That wants to be an explicit answer rather than an accident of iteration order, so it is the one the
 * existing single-file resolution would have picked.
 *
 * `APM_STORE_PATH` splits on the platform's path delimiter, the same convention as `PATH` itself, which
 * carries the same caveat: a POSIX filename may legally contain a colon and one here would be read as two
 * paths. Repeating `--store` avoids the question entirely.
 */
export function resolveStorePaths(explicit?: string[]): [string, ...string[]] {
  const listed = pathList(explicit) ?? pathList([process.env.APM_STORE_PATH]);
  if (listed !== undefined) return listed;
  const [first, ...rest] = findStoreUp(process.cwd());
  if (first !== undefined) return [first, ...rest];
  return [homeStorePath()];
}

/**
 * The home store: `attraverso.yaml`, unless only the pre-rename `project.apm.yaml` is there (`IMP-20`), which is
 * then the one in use - a personal plan must not seem to vanish because the default name changed.
 */
function homeStorePath(): string {
  // The directory keeps its pre-rename name for now: moving it is a migration of its own. Read on each call
  // rather than once at import, so a test can point `HOME` somewhere disposable.
  const dir = join(homedir(), ".ai-project-manager");
  const current = join(dir, STORE_FILE);
  const legacy = join(dir, `project${LEGACY_STORE_SUFFIX}`);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

/**
 * The `--store` values in an argv, in order, or undefined if there are none.
 *
 * Repeatable, because a plan can span several files (`IMP-17`), and the first is the primary. A pure
 * function of an argv rather than a reader of `process.argv`, so the server, `apm:check` and the viewer's dev
 * server share one definition instead of three that drift.
 */
export function storePathsIn(argv: string[]): string[] | undefined {
  const found = argv.flatMap((arg, index) => {
    const value = argv[index + 1];
    return arg === "--store" && value !== undefined ? [value] : [];
  });
  return found.length > 0 ? found : undefined;
}

/** The usable paths in a list of possibly-delimited values, or undefined if there are none - so an unset or
 *  entirely placeholder value falls through to the next source rather than resolving to an empty list. */
function pathList(values: (string | undefined)[] | undefined): [string, ...string[]] | undefined {
  const out = (values ?? [])
    .flatMap((value) => (value ?? "").split(delimiter))
    .map((value) => usable(value))
    .filter((value): value is string => value !== undefined)
    .map((path) => (isAbsolute(path) ? path : join(process.cwd(), path)));
  const [first, ...rest] = [...new Set(out)];
  return first === undefined ? undefined : [first, ...rest];
}

/**
 * A path we should actually act on, or undefined. Blank is unset, which matters because the `.mcpb` manifest
 * wires `APM_STORE_PATH` to an optional `user_config` field and an unfilled one arrives as an empty string.
 *
 * The `${` check is the defensive half: if a host ever passes a config placeholder through unsubstituted, we
 * would otherwise try to create a file literally named `${user_config.store_path}` - at `cwd: /` under
 * launchd, which fails with a permission error, kills the server on boot, and presents to the user as "the
 * tools did not appear" with nothing pointing at the cause. Falling back to the default is the better failure.
 */
function usable(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed || trimmed.includes("${")) return undefined;
  return trimmed;
}

/**
 * Walk up from `start` for the nearest directory holding plan files - `attraverso.yaml`, or legacy `*.apm.yaml`
 * (`IMP-20`) - and return **all** of them. Empty if none exists up to the filesystem root.
 *
 * All of them, not the first alphabetically, because a split plan is two files side by side in one repo
 * (`DIST-3`) and picking one of them would silently serve half a plan - which is what happened the moment
 * `cloud.apm.yaml` appeared beside `roadmap.apm.yaml`: `yarn apm:check` reported the cloud half and nothing
 * else, cheerfully. A tool that finds a plan by looking around it should find the plan, not a file from it.
 * The same goes for a directory holding both namings, which is one in the middle of moving to the new one.
 *
 * It stops at the first directory with any match rather than collecting up the whole tree, so a nested
 * checkout does not silently absorb its parent's plan.
 *
 * **`attraverso.yaml` comes first, then the rest alphabetically**, so the primary is the new file wherever there
 * is one - which decides only where a project created at runtime lands. Where that matters, name the files
 * with `--store` and the given order wins.
 */
function findStoreUp(start: string): string[] {
  for (let dir = start; ; ) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = []; // an unreadable directory just means "keep walking up"
    }
    const matches = names
      .filter(isStoreFile)
      .sort((a, b) => Number(b === STORE_FILE) - Number(a === STORE_FILE) || a.localeCompare(b));
    if (matches.length > 0) return matches.map((name) => join(dir, name));
    const parent = dirname(dir);
    if (parent === dir) return []; // reached the root
    dir = parent;
  }
}

/** Distinguishes one writer's scratch file from another's. Process id and a counter rather than a random
 *  name, so a stray one left by a crash says who wrote it and roughly when. */
let scratch = 0;

/**
 * Write `text` over `path` atomically (temp + rename), so a reader or a crash never sees a half-written file.
 * This IS the durability: the write is the commit.
 *
 * **The temp path is per-writer** (`IMP-15`). It was a fixed `<path>.tmp`, which meant concurrent saves all
 * wrote the same scratch file and raced the rename: the first consumed it and the rest failed with `ENOENT`.
 * Within one process `createStoreFile` now serialises saves so they cannot overlap at all, but the unique
 * name is still what makes this safe between *two* processes on one file - `IMP-13` refuses that case, and
 * refusing it depends on reading a hash that a foreign writer has not just truncated under us.
 *
 * A failed rename leaves the scratch file behind, so it is removed on the way out. Best-effort: a store that
 * could not be written is the error worth reporting, not the tidying that also failed.
 */
async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${++scratch}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Serialise the database to `path`, atomically. `only` restricts it to those project ids, which is how one
 * file of several is written without the others' projects leaking into it (`IMP-17`); omitted, it is the
 * whole database, which is what a single-file store always wants.
 */
export async function saveStore(db: Database, path: string, only?: ReadonlySet<string>): Promise<string> {
  // The local account's projects, which in file mode is all of them: `insertStore` stamps that owner on
  // everything it imports, and nothing else can create a project in this process. Passing an owner anyway,
  // rather than exporting the table, keeps one rule - a project is reached through its owner or not at all.
  const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);
  const text = stringifyStore(restrict(await exportStore(db, ownerId), only));
  await writeAtomic(path, text);
  return hashOf(text); // so a caller tracking freshness knows exactly what it left on disk
}

/**
 * Each file as the server would write it, keyed by path (`IMP-19`) - the reference `apm:check` holds a
 * committed file to.
 *
 * **Canonical means "what a save would produce", and nothing else.** Not a separate normaliser with its own
 * rules, which would be a second definition of the layout and would drift from the first; this is the save
 * path's own export and partition, so a file that passes is by construction a file the next save leaves
 * alone. That is the property sync needs: an export differs from what is committed only by what changed.
 *
 * Expects every file already imported into `db`, as `apm:check` does - one runtime, as the server holds it.
 */
export async function canonicalForms(db: Database, loaded: { path: string; store: Store }[]): Promise<Map<string, string>> {
  const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);
  const full = await exportStore(db, ownerId);
  return new Map(
    loaded.map(({ path, store }) => [path, stringifyStore(restrict(full, new Set(store.projects.map((p) => p.id))))]),
  );
}

/** Rewrite a file atomically: temp file, then rename. Exported for `apm:check --fix`, which rewrites a file
 *  exactly as a save would and so should fail exactly as a save would. */
export { writeAtomic };

/** The store narrowed to some project ids, preserving `exportStore`'s order so the result stays deterministic. */
export const restrict = (store: Store, only?: ReadonlySet<string>): Store =>
  only === undefined ? store : { projects: store.projects.filter((project) => only.has(project.id)) };

/** Content hash of the store, as the identity of a particular version of the file. Cheap: these files are
 *  tens of kilobytes and this runs once per mutation, next to a full serialise and a rename. */
const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The hash of what is on disk now, or null if there is no file there. */
async function hashOnDisk(path: string): Promise<string | null> {
  try {
    return hashOf(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * A cheap identity for the file, so the common case - nobody touched it - costs one `stat` and no read.
 *
 * Size rides along with the mtime because a same-millisecond rewrite is not impossible, but neither is the
 * authority here: this only decides whether hashing is worth doing, and the hash decides whether to reload.
 */
async function stampOf(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
}

/**
 * Open the store: rebuild the database from the file, or create it empty if this is a first run. Reports which
 * happened, so the caller can say so.
 *
 * Creating it eagerly rather than leaving the first mutation to write it is what makes a fresh install legible:
 * the file exists to be opened, committed or pointed at from the moment the server starts, instead of a path
 * that only materialises once you happen to write something. It cannot scatter stray stores through a tree,
 * because the only paths that reach here without existing are an explicit `--store` (deliberate) and the
 * home-dir fallback; discovery only ever returns a file it just found.
 */
export async function openStore(db: Database, path: string): Promise<{ created: boolean; hash: string }> {
  if (existsSync(path)) {
    const text = await readFile(path, "utf8");
    await importStore(db, parseStore(text));
    return { created: false, hash: hashOf(text) };
  }
  // an empty database serialises to `projects: []`, which loads back cleanly
  return { created: true, hash: await saveStore(db, path) };
}

/**
 * Refuse two store files that hold the same project, by name.
 *
 * Left to the database this surfaces as a unique-index violation naming a column and two uuids, which says
 * nothing about which files are involved - and the files are the only thing that can say. The mistake is a
 * plausible one: copy a plan file to start a second one, forget to re-key it.
 *
 * Shared by every loader rather than owned by `createStoreFile`, because `apm:check` is where a person most
 * likely meets it, and a check that reported the raw constraint error would be the least helpful place for
 * the readable version to be missing.
 */
export function assertDistinctProjects(loaded: { path: string; store: Store }[]): void {
  const seen = new Map<string, string>();
  for (const { path, store } of loaded) {
    for (const project of store.projects) {
      for (const handle of [`key "${project.key}"`, `id ${project.id}`]) {
        const first = seen.get(handle);
        if (first !== undefined && first !== path) {
          throw new Error(`${path} and ${first} both hold project ${handle} - two store files cannot share a project`);
        }
        seen.set(handle, path);
      }
    }
  }
}

/**
 * The store file with the one piece of state that makes writing to it safe: the hash of the version this
 * process last read or wrote (`IMP-13`).
 *
 * **Why a guard is needed at all.** A mutation rewrites the *whole* file, so two processes on one store do not
 * interleave, they overwrite - the later write silently discards everything the other did since it last
 * loaded. That is not hypothetical: on 2026-07-30 two Claude Code windows on one repo destroyed a ticket that
 * had been created, acknowledged and correctly written minutes earlier. Nothing errored, and the window that
 * lost the ticket went on reporting it as present, because it was still in that process's memory.
 *
 * **The fix is on the second writer, not the first.** The bug report's instinct was to confirm the flush
 * before reporting success; that would have changed nothing, since the flush happened and was correct. What is
 * missing is that the *next* process to write never checks whether the file is still the one it read.
 *
 * **This is a guard, not a mutex.** Two processes can still race between the check and the rename, and no
 * amount of checking closes that without a lock (`IMP-13` step 3). It closes the case that actually occurs -
 * writes minutes apart from two windows a person is switching between - and it converts a silent destruction
 * into a refusal, which is the difference that matters.
 *
 * **A refused save leaves the database ahead of the file**, so the error says so plainly. The server cannot
 * quietly reconcile: re-applying an arbitrary mutation onto a reloaded database is not generally possible, and
 * merging two whole-file writes is a merge algorithm over a format git already merges better. What `IMP-10`
 * changed is the ending: `refresh` reloads before the next call does anything, so the process recovers by
 * itself instead of refusing every write until someone reconnects it. The one mutation caught in between is
 * still lost, and the error is what says so.
 *
 * **`refresh` is the other half, and the more important one** (`IMP-10`). The file changes under a running
 * server constantly - a `git pull`, a branch switch, a hand edit, the other window - and a process that keeps
 * answering from the copy it booted with returns wrong answers rather than errors, which for a memory tool is
 * the worst failure shape there is. Checked on read rather than watched: `fs.watch` is inconsistent across
 * platforms and misses exactly the rename-based replacement git does, whereas a check on the read path has no
 * window in which a change can have happened and the check not run.
 */
export interface StoreFile {
  /** The primary store: where a project created at runtime lands, and what the viewer resolves media against. */
  path: string;
  /** Every store file this process loaded, primary first (`IMP-17`). One entry in the ordinary case. */
  paths: string[];
  /** Load the files into `db` (creating an empty one on a first run), remembering what was read. */
  open(db: Database): Promise<{ created: boolean }>;
  /** Rebuild `db` from the files if something else changed one since we last read or wrote it. True if it did. */
  refresh(db: Database): Promise<boolean>;
  /** Serialise `db` over the files, refusing if one is no longer the version we last read or wrote. */
  save(db: Database): Promise<void>;
  /**
   * Append newly recorded measurements to their month files (`METRIC-2`).
   *
   * Separate from `save` on purpose: `save` re-serialises the whole plan, which is exactly what these rows are
   * kept out of. An append costs the new rows and nothing else, and it is why a year of readings does not make
   * recording one number expensive.
   */
  appendMeasurements(records: MeasurementRecord[]): Promise<void>;
}

/**
 * One store file's place in this process: the version it is working from, and which projects came out of it.
 *
 * **`ids` and `keys` are runtime state and are never serialised.** A file that recorded its own path or its
 * own membership would be wrong the moment a checkout moved or a project was migrated between halves of the
 * split, and the file is the source of truth precisely because it holds no facts about its environment.
 */
interface Tracked {
  path: string;
  /** Content hash of the version this process last read or wrote, or null before it has seen one. */
  known: string | null;
  /** `stat` identity of that version, so the untouched case costs one syscall and no read. */
  stamp: string | null;
  /** Project ids this file supplied. */
  ids: Set<string>;
  /** Project keys this file supplied, for routing a measurement to the right month directory. */
  keys: Set<string>;
}

export function createStoreFile(where: string | string[]): StoreFile {
  const files: Tracked[] = (typeof where === "string" ? [where] : where).map((path) => ({
    path,
    known: null,
    stamp: null,
    ids: new Set(),
    keys: new Set(),
  }));
  const primary = files[0];
  // Not reachable through `resolveStorePaths`, which always yields one; a direct caller passing `[]` would
  // otherwise get a store that silently holds nothing.
  if (primary === undefined) throw new Error("a store needs at least one file path");

  const claim = (file: Tracked, store: Store): void => {
    file.ids = new Set(store.projects.map((project) => project.id));
    file.keys = new Set(store.projects.map((project) => project.key));
  };

  /** Measurements for every store, read once per directory: two plan files committed side by side in one repo
   *  share a `.apm/measurements`, and reading it twice would double every reading it holds. */
  const loadAllMeasurements = async (db: Database): Promise<void> => {
    const dirs = [...new Set(files.map((file) => measurementsDirFor(file.path)))];
    const records: MeasurementRecord[] = [];
    for (const dir of dirs) records.push(...(await readMeasurements(dir)));
    await loadMeasurements(db, records);
  };

  const remember = async (file: Tracked, hash: string): Promise<void> => {
    file.known = hash;
    file.stamp = await stampOf(file.path);
  };

  /**
   * One file operation at a time (`IMP-15`). Both `refresh` and `save` read the files and then update `known`
   * and `stamp` from what they found, and neither is atomic, so overlapping them corrupts the pair.
   *
   * Overlapping saves was the loud half: they used to race one scratch file and fail with `ENOENT`. The quiet
   * half is worse and is why this covers `refresh` too. Between a save's `rename` and its `remember` the file
   * on disk is new while `known` still holds the previous hash, so a refresh landing in that window reads a
   * hash it does not recognise, concludes a foreign process wrote the file, and runs `replaceStore` - clearing
   * the database and rebuilding it from a snapshot that predates any insert committed since. A dropped
   * ticket, no error, nothing to notice.
   *
   * This is reachable in normal use rather than exotic: `guarded` refreshes at the start of every tool call
   * and persists at the end, and Claude Code fans out independent tool calls by design.
   *
   * **Honest about the evidence**: the overlapping-save half is covered by a test that was proved to fail
   * without this. The refresh half is not - the window is a single `stat` wide, and removing the queue while
   * keeping the per-writer temp name leaves every test passing (measured 2026-08-09). Hitting it reliably
   * would need a seam existing only to slow the save down. Kept on the argument rather than the test, because
   * the cost is one promise chain and the failure it prevents is a silently dropped ticket.
   *
   * One queue across every file rather than one each, because `refresh` and `save` both span all of them: a
   * per-file lock would let a save of one interleave with a reload of another, which is the same torn state
   * the queue exists to prevent.
   *
   * A queue rather than a lock, because the work is already promise-shaped. Failures do not poison it - the
   * chain continues either way, and each caller still sees its own outcome.
   */
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    // `work` in both slots so a failure does not poison the chain: the next queued call runs either way,
    // and each caller still gets its own outcome from `run`.
    const run = queue.then(work, work);
    // The no-ops change no ordering whatsoever (verified) - they exist to attach a rejection handler to `run`
    // *now*. Chaining `queue = run` attaches nothing, so `run` stays an orphan until the next call happens to
    // handle it, and if none comes a failure becomes an unhandled rejection, which Node terminates the process
    // for by default. That combination is reachable: an `IMP-13` refusal is an expected failure, this server is
    // long-lived, and one missed `await` on a persist would turn a refused save into a dead server mid-session.
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  return {
    path: primary.path,
    paths: files.map((file) => file.path),

    // Not queued: this runs once at boot, before the server accepts a call, so there is nothing to race.
    async open(db) {
      // Every file is read and parsed before any of it is inserted, so a second store that does not parse
      // fails with nothing loaded rather than with half a plan in the database.
      const loaded: { file: Tracked; store: Store }[] = [];
      for (const file of files) {
        if (!existsSync(file.path)) {
          loaded.push({ file, store: { projects: [] } });
          continue;
        }
        const text = await readFile(file.path, "utf8");
        loaded.push({ file, store: parseStore(text) });
        file.known = hashOf(text);
      }
      assertDistinctProjects(loaded.map(({ file, store }) => ({ path: file.path, store })));

      let created = false;
      for (const { file, store } of loaded) {
        claim(file, store);
        await importStore(db, store);
      }
      for (const { file } of loaded) {
        // A first run writes the empty file eagerly, for the reason `openStore` gives: a path that only
        // materialises once you happen to write something is not a path you can commit or point at.
        if (file.known === null) {
          created = true;
          await remember(file, await saveStore(db, file.path, file.ids));
        } else {
          file.stamp = await stampOf(file.path);
        }
      }
      // After the plan, always: a measurement names its subject by item ref, so the items have to be there
      // for it to resolve (METRIC-2).
      await loadAllMeasurements(db);
      return { created };
    },

    // Not queued either: an append touches only the month files, which `save` and `refresh` never read or
    // write, so there is nothing here for them to race with.
    async appendMeasurements(records) {
      // Routed by the project key the record already carries, so a reading lands beside the plan that owns
      // its subject. An unrecognised key goes to the primary, which is where its project would have been
      // created moments earlier.
      const byPath = new Map<string, MeasurementRecord[]>();
      for (const record of records) {
        const owner = files.find((file) => file.keys.has(record.project)) ?? primary;
        const dir = measurementsDirFor(owner.path);
        (byPath.get(dir) ?? byPath.set(dir, []).get(dir)!).push(record);
      }
      for (const [dir, rows] of byPath) await appendMeasurements(dir, rows);
    },

    refresh: (db) => exclusive(async () => {
      const fresh = new Map<Tracked, { store: Store; hash: string; stamp: string }>();
      for (const file of files) {
        const current = await stampOf(file.path);
        // Untouched, or gone. A missing file is deliberately **not** a reload: there is nothing to load, and
        // emptying the plan because someone checked out a branch that predates it would be the worst available
        // reading of "the file changed". `save` still refuses, so nothing is written over whatever did that.
        if (current === null || current === file.stamp) continue;

        const text = await readFile(file.path, "utf8");
        const hash = hashOf(text);
        if (hash === file.known) {
          file.stamp = current; // our own write seen again, or a touch that changed no bytes
          continue;
        }
        // Parsed before anything is cleared, and nothing is recorded until every file has parsed: a
        // half-written or badly-merged file must leave the loaded plan intact, and must keep failing on every
        // call rather than once. A server serving a plan it can no longer re-read should say so every time it
        // is asked.
        fresh.set(file, { store: parseStore(text), hash, stamp: current });
      }
      if (fresh.size === 0) return false;

      // The runtime holds the *union* of the files, so a change in one rebuilds from all of them. Reloading
      // only the file that moved would mean clearing part of the database, and a partial clear is a second
      // way for the two to disagree; the files are tens of kilobytes, so re-reading them is not worth
      // inventing one for. Files that did not move (or have gone missing) contribute what is already loaded.
      const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);
      const loadedNow = await exportStore(db, ownerId);
      const claimed = new Set(files.flatMap((file) => [...file.ids]));
      const union: { file: Tracked; store: Store }[] = files.map((file) => {
        const moved = fresh.get(file);
        if (moved !== undefined) return { file, store: moved.store };
        // A project created since the last save belongs to nobody yet; it is the primary's, which is where a
        // save would have put it.
        const mine = loadedNow.projects.filter((p) => file.ids.has(p.id) || (file === primary && !claimed.has(p.id)));
        return { file, store: { projects: mine } };
      });
      assertDistinctProjects(union.map(({ file, store }) => ({ path: file.path, store })));

      await replaceStore(db, { projects: union.flatMap(({ store }) => store.projects) });
      for (const { file, store } of union) {
        claim(file, store);
        const moved = fresh.get(file);
        if (moved !== undefined) {
          file.known = moved.hash;
          file.stamp = moved.stamp;
        }
      }
      // `clearAll` truncates every table, measurements included, so a reload has to bring them back or a
      // branch switch would silently empty a year of readings that no plan file ever held.
      await loadAllMeasurements(db);
      return true;
    }),

    save: (db) => exclusive(async () => {
      // Every file is checked before any is written: a refusal must leave the whole set as it was, or a
      // mutation spanning two plans would land in one of them and be refused by the other.
      for (const file of files) {
        const current = await hashOnDisk(file.path);
        if (file.known !== null && current !== file.known) {
          const gone = current === null;
          throw new Error(
            `refusing to save: ${file.path} ${gone ? "has been deleted" : "has changed"} since this server loaded it, ` +
              "so writing would overwrite whatever changed it (another apm server, a git checkout, or a hand edit). " +
              "This change was applied in memory but NOT saved. " +
              (gone
                ? "Restore the file, or reconnect the apm server to start a fresh one, then make the change again."
                : "The next call reloads the file, which discards this change, so make it again after that."),
          );
        }
      }

      // Exported once and partitioned, rather than exported per file: one query, and the files cannot
      // disagree about a project that changed between two reads of the database.
      const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);
      const full = await exportStore(db, ownerId);
      const claimed = new Set(files.flatMap((file) => [...file.ids]));
      for (const file of files) {
        const mine = full.projects.filter((p) => file.ids.has(p.id) || (file === primary && !claimed.has(p.id)));
        const text = stringifyStore({ projects: mine });
        const hash = hashOf(text);
        // Nothing of this file's changed, so it is not rewritten at all. That is what keeps a mutation to one
        // half of a split plan out of the other half's git history, and it is why `persist()` can stay
        // argumentless: the files work out for themselves which of them a change belonged to.
        if (hash === file.known) continue;
        await writeAtomic(file.path, text);
        claim(file, { projects: mine });
        await remember(file, hash);
      }
    }),
  };
}

/**
 * The store's two side effects with a database already bound, as the transport layer sees them: write through
 * after a mutation, refresh before a read.
 *
 * One value rather than two loose callbacks, so nothing can be handed the ability to write without the ability
 * to notice it is out of date - which is precisely the pair the viewer host and the tool layer each need.
 */
export interface StoreAccess {
  persist(): Promise<void>;
  refresh(): Promise<boolean>;
  /** Append recorded measurements to their month files, without re-serialising the plan (`METRIC-2`). */
  appendMeasurements(records: MeasurementRecord[]): Promise<void>;
}

export const accessTo = (store: StoreFile, db: Database): StoreAccess => ({
  persist: () => store.save(db),
  refresh: () => store.refresh(db),
  appendMeasurements: (records) => store.appendMeasurements(records),
});
