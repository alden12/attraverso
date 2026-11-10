/**
 * The in-process library (`DIST-6`): open a plan and call it directly, typed, with no child process and no MCP.
 *
 * The MCP tools are written for a model - budget-bounded replies in prose - and a program reading them has to
 * parse our display text back into data (Law & Lore's `store.ts` did, by regex). This is the program's own
 * door onto the same domain functions, so a write here is exactly a tool call's write: one transaction, an
 * event row, then the plan re-serialised and handed to `save`.
 *
 * **It runs in a browser.** Nothing this module reaches imports Node: the plan arrives as YAML text and leaves
 * through a callback, the migrations are compiled in (`db/bundledMigrations.ts`), and PGlite is WASM either way.
 * Where the text is kept - a file, IndexedDB, the origin-private file system - is the caller's business, which
 * is what lets one build serve a Node script and a static site. A file-backed `openPlan(paths)`, with the
 * server's reload and stale-write guard (`IMP-10`, `IMP-13`), is the Node-only follow-up `DIST-6` describes.
 *
 * **The public types are declared here, and only here.** Every exported signature names a type from this file
 * rather than a database row, so the published `.d.ts` is self-contained (the build fails if it is not) and a
 * column added to the schema is not an API change. The mapping from rows is at the bottom.
 *
 * **One writer.** Like the MCP server, a plan opened here assumes nothing else writes the same text while it is
 * open. Two handles on one plan would each save over the other.
 */
import { createInMemoryDb } from "../db/memory";
import { exportStore, importStore, parseStore, stringifyStore } from "../serialise/plan";
import { ensureUser, LOCAL_IDENTITY } from "../domain/users";
import { createProjectWithDefaults, getProjectByKey, listProjects, type OwnedProject } from "../domain/projects";
import { createItem, editItem, getItem, getItemDetail, listItems, setStatus, type Item as ItemRow, type ItemSummary as ItemSummaryRow } from "../domain/items";
import { addComment, listComments, type Comment as CommentRow } from "../domain/comments";
import { getSection, setSection } from "../domain/context";
import { search, DEFAULT_LIMIT } from "../domain/search";

// ---------------------------------------------------------------------------------------------------------------
// Public types

export interface PlanOptions {
  /** The plan as YAML, as an `attraverso.yaml` holds it. Absent or blank opens an empty plan. */
  yaml?: string;
  /**
   * Called with the whole plan, re-serialised, after every change - the write-through a plan file gets on disk.
   * Awaited, so a write resolves only once its save has; a save that throws fails the write that caused it.
   * Saves run one at a time, in the order of the writes. Omitted, changes live only as long as the handle.
   */
  save?: (yaml: string) => void | Promise<void>;
  /** Who the event log and new comments name as the author. Defaults to `"claude"`, as the MCP tools write. */
  actor?: string;
}

export interface Plan {
  /** Every project in the plan, by key. */
  listProjects(): Promise<ProjectInfo[]>;
  /** Create a project, seeded with the starter `protocol` section as `create_project` seeds it. */
  createProject(input: NewProject): Promise<ProjectInfo>;
  /** A handle on one project. Rejects when there is no project with that key. */
  project(key: string): Promise<PlanProject>;
  /** The plan as YAML right now: what `save` was last given, or would be. */
  toYaml(): Promise<string>;
  /** Release the database. The handle is unusable afterwards. */
  close(): Promise<void>;
}

export interface PlanProject {
  readonly key: string;
  /** Live items, area then ref order, without bodies: a listing is an index. */
  listItems(filter?: ItemFilter): Promise<ItemSummary[]>;
  /** One item with its body, dependency refs and comments (newest first), or null when no item has that ref. */
  getItem(ref: string): Promise<ItemDetail | null>;
  createItem(input: NewItem): Promise<Item>;
  /** Revise the title, body or dependencies (`deps` replaces the whole set). At least one must be given. */
  editItem(ref: string, changes: ItemChanges): Promise<Item>;
  setStatus(ref: string, status: string): Promise<Item>;
  /** Comment on an item. Capped at 800 characters, as the tool is; a comment is always about an item (`CTX-15`). */
  addComment(ref: string, body: string, options?: { audience?: "user" | "agent" }): Promise<Comment>;
  /** Newest first. `ref` narrows to one item's comments; `null` to the older ones left on the project itself. */
  listComments(options?: { ref?: string | null; audience?: "user" | "agent"; limit?: number }): Promise<Comment[]>;
  /** A context section's markdown, or null when there is no section with that heading. */
  getSection(heading: string): Promise<string | null>;
  /** Create or replace a section. `after` places it after that heading, or first when `null`. */
  setSection(heading: string, content: string, options?: { after?: string | null }): Promise<void>;
  /** Full-text search over items, comments and sections, best first. */
  search(query: string, options?: { limit?: number }): Promise<SearchResult>;
}

export interface ProjectInfo {
  key: string;
  name: string;
  /** Open vocabulary: "software", "learning", ... */
  type: string;
  direction: string | null;
}

export interface NewProject {
  key: string;
  name: string;
  type: string;
  direction?: string;
}

export interface ItemFilter {
  area?: string;
  status?: string;
}

export interface ItemSummary {
  /** The human ref, `AREA-3` or dotted `AREA-3.1` for a child. */
  ref: string;
  /** The ref's prefix. */
  area: string;
  /** The parent's ref for a dotted ref, otherwise null. Nesting is derived from the ref, never set apart from it. */
  parent: string | null;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Planned days, `YYYY-MM-DD`. */
  start: string | null;
  due: string | null;
}

export interface Item extends ItemSummary {
  /** Markdown. Empty when the item has none. */
  body: string;
}

export interface ItemDetail extends Item {
  /** Refs this item depends on. */
  deps: string[];
  comments: Comment[];
}

export interface NewItem {
  /** The ref prefix to allocate the next ref under. Optional when `ref` or `parent` implies it. */
  area?: string;
  /** An exact ref to take, rather than the next one. */
  ref?: string;
  /** Create beneath this ref, as its next child. */
  parent?: string;
  title: string;
  body?: string;
  /** Defaults to `to-do`. */
  status?: string;
  deps?: string[];
}

export interface ItemChanges {
  title?: string;
  body?: string;
  deps?: string[];
}

export interface Comment {
  id: string;
  /** The item it is on, or null for a comment on the project itself. */
  ref: string | null;
  body: string;
  audience: string;
  actor: string;
  at: string;
}

export interface SearchHit {
  source: "item" | "comment" | "context";
  /** The item the hit is about (its own ref, or the item a comment is on); null for the project's own. */
  ref: string | null;
  /** How to address the thing itself: a ref, a comment id, a section heading. */
  id: string;
  /** An item's title or a section's heading; null for a comment. */
  title: string | null;
  /** Matched fragments, terms wrapped in `**`. Quotes the text it matched, so treat it as that text. */
  snippet: string;
  rank: number;
  audience: string | null;
  at: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** True when nothing held every term and the search fell back to any of them. */
  relaxed: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// The handle

export async function openPlan(options: PlanOptions = {}): Promise<Plan> {
  const actor = options.actor ?? "claude";
  const { db, close } = await createInMemoryDb();
  try {
    // A blank document parses to null, which is a new plan rather than a malformed one.
    if (options.yaml !== undefined && options.yaml.trim() !== "") await importStore(db, parseStore(options.yaml));
  } catch (error) {
    await close();
    throw error;
  }
  // The single local account, as the stdio server acts as: `importStore` stamps it on everything it loads.
  const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);

  const toYaml = async (): Promise<string> => stringifyStore(await exportStore(db, ownerId));

  // Saves are chained so they land in the order of the writes even when a caller does not await between them.
  // A failed save rejects its own write and does not poison the next one.
  let saving: Promise<unknown> = Promise.resolve();
  const persist = async (): Promise<void> => {
    const save = options.save;
    if (save === undefined) return;
    const next = saving.then(async () => save(await toYaml()));
    saving = next.catch(() => {});
    await next;
  };
  /** A mutation, then its save, so a write resolves only once it is durable wherever `save` puts it. */
  const writing = async <T>(work: () => Promise<T>): Promise<T> => {
    const result = await work();
    await persist();
    return result;
  };

  const resolve = async (key: string): Promise<OwnedProject> => {
    const project = await getProjectByKey(db, ownerId, key);
    if (project === null) throw new Error(`no project with key "${key}"`);
    return project;
  };

  const handle = (project: OwnedProject): PlanProject => {
    const projectId = project.id;
    const itemIdOf = async (ref: string): Promise<string> => {
      const found = await getItem(db, projectId, ref);
      if (found === null) throw new Error(`no item "${ref}" in ${project.key}`);
      return found.id;
    };

    return {
      key: project.key,
      listItems: async (filter = {}) => (await listItems(db, { projectId, ...filter })).map(summaryOf),
      getItem: async (ref) => {
        const detail = await getItemDetail(db, projectId, ref);
        if (detail === null) return null;
        return { ...itemOf(detail.item), deps: detail.deps, comments: detail.comments.map((c) => commentOf(c, detail.item.ref)) };
      },
      createItem: (input) => writing(async () => itemOf(await createItem(db, { projectId, ...input }, actor))),
      editItem: (ref, changes) => writing(async () => itemOf(await editItem(db, { projectId, ref, ...changes }, actor))),
      setStatus: (ref, status) => writing(async () => itemOf(await setStatus(db, { projectId, ref, status }, actor))),
      addComment: (ref, body, { audience } = {}) =>
        writing(async () => {
          const itemId = await itemIdOf(ref);
          return commentOf(await addComment(db, { projectId, body, itemId, audience }, actor), ref);
        }),
      listComments: async ({ ref, audience, limit } = {}) => {
        const itemId = ref === undefined || ref === null ? ref : await itemIdOf(ref);
        const rows = await listComments(db, { projectId, itemId, audience, limit });
        const refById = new Map((await listItems(db, { projectId })).map((i) => [i.id, i.ref]));
        return rows.map((c) => commentOf(c, c.itemId === null ? null : (refById.get(c.itemId) ?? null)));
      },
      getSection: async (heading) => (await getSection(db, projectId, heading))?.content ?? null,
      setSection: (heading, content, { after } = {}) =>
        writing(async () => {
          await setSection(db, { projectId, heading, content, after }, actor);
        }),
      search: async (query, { limit = DEFAULT_LIMIT } = {}) => {
        const { hits, relaxed } = await search(db, projectId, query, limit);
        return { hits: hits.map((hit) => ({ ...hit })), relaxed };
      },
    };
  };

  return {
    listProjects: async () => (await listProjects(db, ownerId)).map(projectOf),
    createProject: (input) => writing(async () => projectOf(await createProjectWithDefaults(db, { ...input, ownerId }, actor))),
    project: async (key) => handle(await resolve(key)),
    toYaml,
    close: async () => {
      await saving;
      await close();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Rows to public records. Explicit field by field, so a column added to the schema stays out of the API until
// someone decides it belongs in it.

const projectOf = (p: OwnedProject): ProjectInfo => ({ key: p.key, name: p.name, type: p.type, direction: p.direction ?? null });

/** `A-3.1` -> `A-3`; an undotted ref has no parent. */
const parentOf = (ref: string): string | null => (ref.includes(".") ? ref.slice(0, ref.lastIndexOf(".")) : null);

const summaryOf = (i: ItemSummaryRow): ItemSummary => ({
  ref: i.ref,
  area: i.areaKey,
  parent: parentOf(i.ref),
  title: i.title,
  status: i.status,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
  closedAt: i.closedAt,
  start: i.startOn,
  due: i.dueOn,
});

const itemOf = (i: ItemRow): Item => ({ ...summaryOf(i), body: i.body ?? "" });

const commentOf = (c: CommentRow, ref: string | null): Comment => ({ id: c.id, ref, body: c.body, audience: c.audience, actor: c.actor, at: c.createdAt });
