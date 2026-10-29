/**
 * Items (DATA-6): the plan layer. One table for tickets and, later, skills and care items, with no type
 * column - see the schema. This module also does id allocation (DATA-7) and status validation.
 *
 * The storage and domain layers speak of "items"; the MCP tools say "ticket", because that is what a person
 * means. Genericity lives in the schema, not the vocabulary.
 */
import { and, asc, count, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { sortPath, timestamp } from "../db/ids";
import { one, maybeOne } from "../db/rows";
import { dependencies, items } from "../db/schema";
import type { OwnedProjectId } from "./owned";
import { mutate, type Actor } from "./events";
import { dependencyRefs, setDependencies } from "./dependencies";
import { listComments, type Comment } from "./comments";
import { areaOf, isCalendarDate, isRef, parentRef, STATUSES, type Status } from "../../scripts/tickets";

export type Item = typeof items.$inferSelect;

const isStatus = (value: string): value is Status => Object.prototype.hasOwnProperty.call(STATUSES, value);

/** Validate against the fixed vocabulary in one place; the schema leaves `status` an open string on purpose. */
function assertStatus(value: string): asserts value is Status {
  if (!isStatus(value)) throw new Error(`unknown status "${value}"; expected one of ${Object.keys(STATUSES).join(", ")}`);
}

/**
 * Check an item's planned dates (`CAL-1`), as they will stand after the write: each a real calendar day, and a
 * start no later than its due. Checked against the *resulting* pair, so moving a due date earlier than an
 * existing start is caught by an edit that only names the due date.
 */
function assertDates(start: string | null, due: string | null): void {
  for (const [name, value] of [["start", start], ["due", due]] as const) {
    if (value !== null && !isCalendarDate(value)) throw new Error(`${name} "${value}" is not a calendar date; expected YYYY-MM-DD, like 2026-11-02`);
  }
  // Fixed-width dates order as text, so this is a date comparison.
  if (start !== null && due !== null && start > due) throw new Error(`start ${start} is after due ${due}`);
}

/** The highest `sort_path` among a set of siblings, as the number of its last segment. Because a `sort_path`
 *  segment is just the zero-padded ref number, this is "the highest N so far" with no string parsing in SQL. */
async function highestSibling(tx: Tx, where: SQL | undefined): Promise<number> {
  const row = maybeOne(await tx.select({ max: sql<string | null>`max(${items.sortPath})` }).from(items).where(where));
  if (!row?.max) return 0;
  return parseInt(row.max.slice(row.max.lastIndexOf(".") + 1), 10);
}

/** Advisory locks share one server-wide space, so ours are namespaced by a constant in the first of the two
 *  int4 keys. Arbitrary, only has to be ours and stay put. */
const ALLOCATION_LOCK = 0x61706d31; // "apm1"

/** An item's ref, area and parent, however the caller chose to specify them. */
interface Allocation {
  ref: string;
  path: string;
  area: string;
  parentId: string | null;
}

/**
 * Work out the ref a new item gets. Three ways in, in precedence order:
 *
 *   1. an **explicit ref** (`MCP-18`), which migration needs and which lets a body reference a ticket that
 *      does not exist yet, since the caller no longer has to create it first to learn its number;
 *   2. a **parent ref**, allocating the next child beneath it (`MCP-3` -> `MCP-3.2`);
 *   3. an **area**, allocating the next top-level ref in it (`DATA` -> `DATA-7`).
 *
 * Deleted items still hold their refs here (no `deleted_at` filter), which is deliberate: reusing `MCP-3`
 * after deleting it would silently retarget every body, note and commit message that mentions it.
 *
 * **Allocation is serialised per project by an advisory lock, and that is load-bearing on real Postgres**
 * (fixed 2026-08-09, `OPS-2`). Two of these three paths are `max(sort_path) + 1`, a textbook read-modify-write
 * race: under READ COMMITTED two overlapping transactions both read `MCP-19` and both try to write `MCP-20`.
 * This code previously relied on the race being impossible, which was true only because PGlite runs one
 * connection and serialises `db.transaction` itself. Running the suite against server Postgres broke exactly
 * the test that pinned that assumption, which is the whole reason for running it there.
 *
 * A lock rather than retrying on the unique violation, because parallel creates are the *designed* case
 * (Claude Code fans out independent tool calls, so "create five tickets" arrives as five overlapping ones).
 * Retrying makes contention quadratic - each round lets exactly one winner through - whereas the lock costs
 * one round trip and turns the contended case into an orderly queue. The unique index stays as the backstop
 * that would catch this being got wrong again.
 */
async function allocate(tx: Tx, projectId: OwnedProjectId, input: NewItem): Promise<Allocation> {
  // Held until the transaction ends, so it covers the read, the insert and the commit with no explicit
  // release and nothing leaked on an abort. Keyed per project, which is the unit contention actually happens
  // in; the constant namespaces our locks against anyone else's use of the same advisory space.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${ALLOCATION_LOCK}, hashtext(${projectId}))`);

  if (input.ref !== undefined) {
    const ref = input.ref.trim();
    if (!isRef(ref)) throw new Error(`"${ref}" is not a valid ref: expected an area prefix and dotted numbers, like MCP-3 or MCP-3.1`);
    const clash = await byRef(tx, projectId, ref);
    if (clash !== null) throw new Error(`ref "${ref}" is already taken by: ${clash.title}`);
    const parent = parentRef(ref);
    return { ref, path: sortPath(ref), area: areaOf(ref), parentId: parent === null ? null : (await requireRef(tx, projectId, parent)).id };
  }

  if (input.parent !== undefined) {
    const parent = await requireRef(tx, projectId, input.parent.trim());
    const next = (await highestSibling(tx, and(eq(items.projectId, projectId), eq(items.parentId, parent.id)))) + 1;
    const ref = `${parent.ref}.${next}`;
    return { ref, path: sortPath(ref), area: parent.areaKey, parentId: parent.id };
  }

  if (input.area === undefined) throw new Error("give an area (or a parent ref, or an explicit ref) to create a ticket under");
  const area = input.area.trim().toUpperCase(); // the ref prefix convention is upper-case (DATA, MCP)
  const next = (await highestSibling(tx, and(eq(items.projectId, projectId), eq(items.areaKey, area), isNull(items.parentId)))) + 1;
  const ref = `${area}-${next}`;
  return { ref, path: sortPath(ref), area, parentId: null };
}

const byRef = async (tx: Tx, projectId: OwnedProjectId, ref: string): Promise<Item | null> =>
  maybeOne(await tx.select().from(items).where(and(eq(items.projectId, projectId), eq(items.ref, ref))));

async function requireRef(tx: Tx, projectId: OwnedProjectId, ref: string): Promise<Item> {
  const item = await byRef(tx, projectId, ref);
  if (item === null) throw new Error(`no ticket "${ref}" in this project`);
  return item;
}

export interface NewItem {
  projectId: OwnedProjectId;
  /** The ref prefix to allocate under. Optional only because `ref` or `parent` can imply it instead. */
  area?: string;
  /** An exact ref to take, rather than allocating the next one (MCP-18). */
  ref?: string;
  /** Create beneath this ref, as the next child (MCP-17). Nesting is derived from the ref, so this allocates
   *  a dotted one rather than setting a parent independently. */
  parent?: string;
  title: string;
  body?: string;
  status?: string;
  /** Refs this item depends on. Validated and cycle-checked like any other dependency edit. */
  deps?: string[];
  /** Planned dates, `YYYY-MM-DD` (`CAL-1`). Both optional: an undated item is the normal case. */
  start?: string | null;
  due?: string | null;
}

export async function createItem(db: Database, input: NewItem, actor: Actor): Promise<Item> {
  const status = input.status ?? "to-do";
  assertStatus(status);
  const startOn = input.start ?? null;
  const dueOn = input.due ?? null;
  assertDates(startOn, dueOn);
  return mutate(db, actor, async (tx) => {
    const { ref, path, area, parentId } = await allocate(tx, input.projectId, input);
    const item = one(
      await tx
        .insert(items)
        .values({ projectId: input.projectId, ref, areaKey: area, sortPath: path, parentId, title: input.title, body: input.body ?? null, status, startOn, dueOn })
        .returning(),
    );
    // After the insert, so a pair of tickets created together can reference each other and so the cycle check
    // sees the finished row rather than a graph the new item is not in yet.
    if (input.deps && input.deps.length > 0) await setDependencies(tx, item, input.deps);
    return { result: item, event: { projectId: input.projectId, entityType: "item", entityId: item.id, kind: "created", after: item } };
  });
}

export interface ItemFilter {
  projectId: OwnedProjectId;
  status?: string;
  area?: string;
}

/**
 * One row of a listing: everything a board, a picker or a ref lookup needs, and **not the body**.
 *
 * The body is the expensive column by a wide margin - this project's 151 tickets carry ~257kB of prose - and
 * no caller of `listItems` has ever read one (measured 2026-09-01: the four call sites want refs, a count, an
 * id-to-ref map, and the board's fields). Selecting it anyway cost about 5ms locally and would cross the
 * network in cloud mode, growing linearly with the plan.
 *
 * Reach for `getItem` or `getItemDetail` when a whole ticket is wanted. That the two are different calls is
 * the point: a listing is an index, and an index that carries its documents is not saving anyone anything.
 */
export type ItemSummary = Pick<Item, "id" | "ref" | "areaKey" | "sortPath" | "parentId" | "title" | "status" | "createdAt" | "updatedAt" | "closedAt" | "startOn" | "dueOn">;

const SUMMARY_COLUMNS = {
  id: items.id,
  ref: items.ref,
  areaKey: items.areaKey,
  sortPath: items.sortPath,
  parentId: items.parentId,
  title: items.title,
  status: items.status,
  createdAt: items.createdAt,
  updatedAt: items.updatedAt,
  closedAt: items.closedAt,
  // Small, and what a listing line shows (`CAL-1`): "what is due" is the question a date exists to answer.
  startOn: items.startOn,
  dueOn: items.dueOn,
} as const;

const listConditions = (filter: ItemFilter) => {
  const conditions = [eq(items.projectId, filter.projectId), isNull(items.deletedAt)];
  if (filter.status) conditions.push(eq(items.status, filter.status));
  if (filter.area) conditions.push(eq(items.areaKey, filter.area.toUpperCase()));
  return and(...conditions);
};

export async function listItems(db: Database, filter: ItemFilter): Promise<ItemSummary[]> {
  // Order by area then sort_path: sort_path encodes only the numeric ref components, so it is unique within
  // an area but collides across areas (DATA-1 and MCP-1 both sort as "000001"). Area first makes it total.
  return db
    .select(SUMMARY_COLUMNS)
    .from(items)
    .where(listConditions(filter))
    .orderBy(asc(items.areaKey), asc(items.sortPath));
}

/**
 * How many items match, without fetching them.
 *
 * `list_tickets` reports an unfiltered total beside a filtered listing (`MCP-21`), and was getting it by
 * listing every ticket and reading `.length` - 151 rows built and thrown away to produce one integer.
 */
export async function countItems(db: Database, filter: ItemFilter): Promise<number> {
  const [row] = await db.select({ n: count() }).from(items).where(listConditions(filter));
  return row?.n ?? 0;
}

export async function getItem(db: Database, projectId: OwnedProjectId, ref: string): Promise<Item | null> {
  return maybeOne(await db.select().from(items).where(and(eq(items.projectId, projectId), eq(items.ref, ref))));
}

export interface ItemDetail {
  item: Item;
  /** Refs this item depends on, ordered stably (area then sort_path). */
  deps: string[];
  /** Comments attached to this item (CTX-2), newest first. */
  comments: Comment[];
}

/** One item with its dependency refs resolved - what a read tool needs to show a whole ticket (body included).
 *  Null when no item has that ref in the project.
 *
 *  Comments come with it rather than needing a second call: a comment attached to a ticket *is* part of that
 *  ticket - what went wrong on it, what was tried - and a reader who has to know to go looking will not. */
export async function getItemDetail(db: Database, projectId: OwnedProjectId, ref: string): Promise<ItemDetail | null> {
  const item = await getItem(db, projectId, ref);
  if (item === null) return null;
  return { item, deps: await dependencyRefs(db, item.id), comments: await listComments(db, { projectId, itemId: item.id }) };
}

export async function setStatus(
  db: Database,
  args: { projectId: OwnedProjectId; ref: string; status: string },
  actor: Actor,
): Promise<Item> {
  assertStatus(args.status);
  return mutate(db, actor, async (tx) => {
    const before = maybeOne(await tx.select().from(items).where(and(eq(items.projectId, args.projectId), eq(items.ref, args.ref))));
    if (before === null) throw new Error(`no ticket "${args.ref}" in this project`);
    const now = timestamp();
    const after = one(
      await tx
        .update(items)
        // Everything closes, so a terminal state stamps closed_at; leaving it clears it again.
        .set({ status: args.status, updatedAt: now, closedAt: args.status === "done" ? now : null })
        .where(eq(items.id, before.id))
        .returning(),
    );
    return { result: after, event: { projectId: args.projectId, entityType: "item", entityId: before.id, kind: "status-changed", before, after } };
  });
}

export interface EditItem {
  projectId: OwnedProjectId;
  ref: string;
  title?: string;
  body?: string;
  /** Replaces the whole dependency set; `[]` clears it. See `setDependencies` for why it is not add/remove. */
  deps?: string[];
  /** Planned dates (`CAL-1`): a `YYYY-MM-DD` sets one, `null` clears it, absent leaves it alone. */
  start?: string | null;
  due?: string | null;
}

/** Revise a ticket's title, body, dependencies and/or planned dates. Status has its own path (`setStatus`), so this never
 *  touches it; at least one field must be given. The whole before/after is logged, so the edit is auditable
 *  and reversible like any other mutation. */
export async function editItem(db: Database, input: EditItem, actor: Actor): Promise<Item> {
  if (input.title === undefined && input.body === undefined && input.deps === undefined && input.start === undefined && input.due === undefined) {
    throw new Error("nothing to edit: provide a title, body, deps, start and/or due");
  }
  return mutate(db, actor, async (tx) => {
    const before = maybeOne(await tx.select().from(items).where(and(eq(items.projectId, input.projectId), eq(items.ref, input.ref))));
    if (before === null) throw new Error(`no ticket "${input.ref}" in this project`);
    const changes: Partial<typeof items.$inferInsert> = { updatedAt: timestamp() };
    if (input.title !== undefined) changes.title = input.title;
    if (input.body !== undefined) changes.body = input.body;
    if (input.start !== undefined) changes.startOn = input.start;
    if (input.due !== undefined) changes.dueOn = input.due;
    assertDates(input.start === undefined ? before.startOn : input.start, input.due === undefined ? before.dueOn : input.due);
    const after = one(await tx.update(items).set(changes).where(eq(items.id, before.id)).returning());
    // Dep refs ride along in the event payload when they changed, because the item row does not carry them:
    // without this a deps-only edit logs a before and after that differ by nothing but `updated_at`.
    const beforeDeps = input.deps === undefined ? undefined : await dependencyRefs(tx, before.id);
    const afterDeps = input.deps === undefined ? undefined : await setDependencies(tx, before, input.deps);
    return {
      result: after,
      event: {
        projectId: input.projectId,
        entityType: "item",
        entityId: before.id,
        kind: "edited",
        before: { ...before, deps: beforeDeps },
        after: { ...after, deps: afterDeps },
      },
    };
  });
}

/**
 * Soft-delete a ticket (MCP-19). Nothing is removed: `deleted_at` is stamped, the row stays, the event log
 * keeps the whole history. That is what lets an agent file freely and correct itself, which is the actual
 * point - the cost of not having this was measured in caution, not in stuck data.
 *
 * Two rules, both to keep the graph honest rather than to protect the row:
 *
 * - **Dependency edges go**, in both directions. An edge to a deleted ticket renders as an edge to nothing,
 *   which is a visible bug; keeping them "in case of undelete" would trade it for an invisible one.
 * - **A ticket with live children is refused**, naming them. Cascading is too destructive for one tool call
 *   made by an agent, and orphaning is worse than either.
 *
 * The ref is *not* freed. `allocate` counts deleted rows when picking the next number, so `MCP-3` stays spent
 * and every body, note and commit message that mentions it keeps meaning what it said.
 */
export async function deleteItem(db: Database, args: { projectId: OwnedProjectId; ref: string }, actor: Actor): Promise<Item> {
  return mutate(db, actor, async (tx) => {
    const before = maybeOne(await tx.select().from(items).where(and(eq(items.projectId, args.projectId), eq(items.ref, args.ref))));
    if (before === null) throw new Error(`no ticket "${args.ref}" in this project`);
    if (before.deletedAt !== null) throw new Error(`${args.ref} is already deleted`);

    const children = await tx
      .select({ ref: items.ref })
      .from(items)
      .where(and(eq(items.parentId, before.id), isNull(items.deletedAt)))
      .orderBy(asc(items.sortPath));
    if (children.length > 0) {
      throw new Error(`${args.ref} has sub-tickets (${children.map((c) => c.ref).join(", ")}) - delete or move those first`);
    }

    await tx.delete(dependencies).where(eq(dependencies.itemId, before.id));
    await tx.delete(dependencies).where(eq(dependencies.dependsOnId, before.id));
    const now = timestamp();
    const after = one(await tx.update(items).set({ deletedAt: now, updatedAt: now }).where(eq(items.id, before.id)).returning());
    return { result: after, event: { projectId: args.projectId, entityType: "item", entityId: before.id, kind: "deleted", before, after } };
  });
}
