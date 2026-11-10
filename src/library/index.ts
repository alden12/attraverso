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
 * **This file is the contract: the public types, declared here and only here.** Every exported signature names a
 * type from this file rather than a database row, so the published `.d.ts` is self-contained (the build fails if
 * it is not) and a column added to the schema is not an API change. The implementation is beside it, in files the
 * declaration never reaches: `open.ts` opens the plan and chains the saves, `project.ts` is a project's handle,
 * and `records.ts` maps rows to these types. Their imports of this file are type-only, so nothing here runs
 * before they do.
 *
 * **One writer.** Like the MCP server, a plan opened here assumes nothing else writes the same text while it is
 * open. Two handles on one plan would each save over the other.
 */
import { open } from "./open";

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

/** Open a plan from its YAML text. See `PlanOptions` for where changes go. */
export function openPlan(options: PlanOptions = {}): Promise<Plan> {
  return open(options);
}
