/**
 * The tool boundary (MCP-2): thin wrappers over the domain layer. Each tool declares a zod input schema
 * (which is also its JSON Schema for the model), calls one domain function, and shapes a short text reply.
 * No business logic lives here - status rules, id allocation and the event log are all in `domain/`.
 *
 * Tools say "item" though the domain says "item": "item" is what a person means, and a generic
 * `create_item` would read worse to the model. Domain errors are returned as readable text with `isError`,
 * so a failed call teaches the model what went wrong instead of surfacing a stack trace.
 *
 * Handlers are given an explicit `CallToolResult` return type on purpose: without it, the SDK's generic
 * `registerTool` inference tries to infer the callback's return through Drizzle's very deep `Database` type
 * and hits TS2589 ("excessively deep"). Annotating the boundary stops that instantiation.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "../db/client";
import { splitScope, STATUS_VALUES } from "../../scripts/tickets";
import { createProjectWithDefaults, getProjectByKey, listProjects, setDirection, type OwnedProject } from "../domain/projects";
import { countItems, createItem, deleteItem, editItem, getItem, getItemDetail, listItems, setStatus, type Item, type ItemDetail } from "../domain/items";
import { dependencyRefsByItem } from "../domain/dependencies";
import { addComment, deleteComment, editComment, listComments, shortCommentId, AUDIENCES, MAX_BODY, SHORT_ID, type Comment } from "../domain/comments";
import { deleteSection, getSection, listSections, setSection, PROTOCOL_HEADING } from "../domain/context";
import { resumeProject, type ContextPack, type PackBoard } from "../domain/memory";
import { setNext, type NextItem } from "../domain/next";
import { listAreas, type AreaSummary } from "../domain/areas";
import { aggregateSeries, listMetrics, recordMeasurements, type Measurement } from "../domain/measurements";
import { toRecords } from "../serialise/measurements";
import { search, DEFAULT_LIMIT as SEARCH_LIMIT, type SearchHit } from "../domain/search";
import type { StoreAccess } from "../serialise/store";
import { suggest } from "./suggest";
import type { ViewerHost } from "./viewer";

/**
 * Who this server instance is acting for (`OPS-4`). Every project the tools can see or create belongs to
 * `ownerId`, and nothing else is reachable - `resolveProject` below takes it as half the identifier rather
 * than filtering afterwards, so a key belonging to someone else is indistinguishable from one that does not
 * exist.
 *
 * A parameter rather than ambient state because `http.ts` builds a fresh `McpServer` and calls `registerTools`
 * **per request**, which was done for statelessness in `OPS-3` and turns out to hand this item the caller
 * scope for free: no async-local storage, no per-call threading, and no server-wide value to get stale.
 */
export interface Caller {
  /** The `users` row whose projects these tools may reach. */
  ownerId: string;
}

// Still a literal, deliberately (OPS-4). Ownership is the security question and is settled above; `actor` is a
// separate one about *attribution*, and the item's own argument is that its eventual shape - an id plus
// whether the edit was direct or agent-mediated - should be forced by the viewer's write path, which is the
// only place today where "who did this" already has a real answer. Changing it here would also rewrite the
// `actor` on every exported comment and attachment, burying a security change under a whole-file diff.
const ACTOR = "claude";

/**
 * When this process started (MCP-20). Module load is process start for a server that does nothing else first,
 * so a constant here needs no plumbing through `registerTools`.
 *
 * Why any of this: the server is long-lived and holds the code it was spawned with, so after a `git pull` or a
 * rebuild it keeps answering from the old build with nothing in any reply to say so. That cost two wrong
 * conclusions in one dogfooding session - a fix read as not working, and a dead process misdiagnosed as a
 * caching bug - because "running" and "current" are different questions and only the first had an answer.
 *
 * Start time rather than a build id, deliberately: under vite-node there is no build artefact to stamp, so a
 * real content hash would need git HEAD or a bundle mtime and would work in only one of the two run modes.
 * "Started 85 minutes ago" is decisive against "I built ten minutes ago", which is the comparison actually
 * being made.
 */
const STARTED_AT = new Date();

/** How long this process has been up, as something a person reads rather than a number they convert. */
function runningFor(now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - STARTED_AT.getTime()) / 60_000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `up ${minutes}m`;
  return `up ${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** The staleness line every long-lived answer should carry: when this build started serving, and for how long.
 *  Phrased as an instruction because the reader is a model deciding whether to trust what it just read. */
const buildStamp = (): string =>
  `server started ${STARTED_AT.toISOString()} (${runningFor()}); if that predates your last change to this repo, reconnect before trusting this`;

/** The dependency field, shared by create and edit so the two cannot describe it differently. Declarative on
 *  purpose: the array is the whole set, which is what lets a wrong edit be corrected rather than only added to. */
/** A planned date (`CAL-1`). Validated in the domain, which names what was wrong with it. */
const date = (what: string) => z.string().describe(`${what}, as YYYY-MM-DD: a calendar day, not a time.`);

const DEPS = z
  .array(z.string())
  .describe(
    "Refs this item depends on (must be done first). Replaces the whole set; pass [] to clear it. " +
      "A ref may name another project, as `key:REF` (e.g. `apm:DIST-1`), which is how an edge survives a plan " +
      "split across store files; it stays valid when that project is not loaded.",
  )
  .optional();

/**
 * A list read as prose: "kg", "kg and lb", "kg, lb and stone".
 *
 * `join(" and ")` is right for two and a run-on past it, and three units in one series is not far-fetched -
 * kg, lb and stone all measure the same thing, so anyone who has switched apps can produce it. Only prose
 * uses this; the comma-separated lists elsewhere are enumerations, where "and" would be wrong.
 *
 * Hand-rolled rather than `Intl.ListFormat`, which would add an Oxford comma this codebase does not use and
 * make the string depend on a locale nothing else here depends on.
 */
const andList = (parts: string[]): string =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const text = (body: string): CallToolResult => ({ content: [{ type: "text", text: body }] });
const errorText = (body: string): CallToolResult => ({ content: [{ type: "text", text: body }], isError: true });

const fmtProject = (p: { key: string; name: string; type: string; direction: string | null }): string => `${p.key} - ${p.name} (${p.type})${p.direction ? `\n  direction: ${p.direction}` : ""}`;
const fmtItem = (i: { ref: string; status: string; title: string; startOn?: string | null; dueOn?: string | null }): string =>
  `${i.ref} [${i.status}] ${i.title}${fmtDates(i.startOn ?? null, i.dueOn ?? null)}`;

/**
 * An item's planned dates as a suffix on its line (`CAL-1`), and nothing for an undated one, which is most of
 * them. On the line rather than in `get_item` alone, because "what is due" is the question a date exists to
 * answer, and a listing that hides it sends every reader to open every item.
 */
function fmtDates(start: string | null, due: string | null): string {
  if (start !== null && due !== null) return ` (${start} to ${due})`;
  if (due !== null) return ` (due ${due})`;
  if (start !== null) return ` (from ${start})`;
  return "";
}

/**
 * A blocker, with its own status. `DATA-1 [review]` and `DATA-1 [planning]` are very different situations - one
 * is a merge away, the other has not been started - and only the reader knows whether either actually stops
 * them, so the line reports rather than judges.
 */
const fmtBlockers = (blockers: { ref: string; status: string }[]): string =>
  blockers.length === 0 ? "" : ` (blocked by ${blockers.map((b) => `${b.ref} [${b.status}]`).join(", ")})`;

/** The agreed order, numbered so the positions are addressable when someone asks to move one. A blocker is
 *  annotated rather than hidden: it is information about the item, not a reason it should not be listed. */
const fmtNext = (list: NextItem[]): string =>
  list.map((n, index) => `${index + 1}. ${fmtItem(n)}${fmtBlockers(n.blockedBy)}`).join("\n");

/**
 * Areas as a table of contents. Shared by `list_areas` and the pack, so the two cannot drift (`CTX-4`).
 *
 * The key is padded and leads, because it is the token `list_items(area:)` takes - the name is what makes the
 * line worth reading, the key is what makes it actionable.
 */
const fmtAreas = (list: AreaSummary[]): string => {
  // Padded so the names line up in a column: this is read as a table of contents, scanned rather than parsed.
  const key = Math.max(0, ...list.map((a) => a.key.length));
  const total = Math.max(0, ...list.map((a) => String(a.total).length));
  return list
    .map((a) => `${a.key.padEnd(key)}  ${String(a.open).padStart(3)} open of ${String(a.total).padEnd(total)}${a.name === null ? "" : `  ${a.name}`}`)
    .join("\n");
};

/**
 * A recorded tree, as it was written: the occurrence first, its readings indented under it.
 *
 * Printed back deliberately. The reply is the only place an agent sees the *shape* it just created, and
 * `METRIC-1`'s whole worry is that nesting gets skipped in favour of a flat `label` - so showing the tree is
 * what makes having built one visible rather than theoretical.
 */
const fmtRecorded = (rows: Measurement[]): string =>
  rows
    .map((r) => {
      const reading = r.value !== null ? `${r.value}${r.unit ? ` ${r.unit}` : ""}` : (r.textValue ?? "-");
      return `${r.parentId === null ? "" : "  "}${r.metric}: ${reading}${r.label ? ` (${r.label})` : ""}`;
    })
    .join("\n");

/** Context sections as a table of contents. Shared by `list_context` and the pack, so the two cannot drift. */
const fmtHeadings = (headings: string[]): string => headings.map((h) => `- ${h}`).join("\n");

/** A nested item's parent, from its own ref: `MCP-3.1.2` -> `MCP-3.1`, and null at the top level. Nesting is
 *  derived from the id by design, so this is the definition rather than a shortcut around `items.parent_id`. */
const parentRef = (ref: string): string | null => (ref.includes(".") ? ref.slice(0, ref.lastIndexOf(".")) : null);

/**
 * One search hit: an address, then the matching passage indented beneath it.
 *
 * The address leads because it is the only part the caller acts on - it decides which hits are worth a
 * `get_item`, and a snippet without one is unopenable. Agent comments are marked, matching how `fmtPack`
 * presents them, so Claude can tell its own working comments from the user's.
 */
const fmtHit = (h: SearchHit): string => {
  const where =
    h.source === "item" ? `${h.id} [item] ${h.title ?? ""}`.trimEnd()
    : h.source === "comment" ? `${h.ref ? `${h.ref} ` : ""}[comment ${shortCommentId(h.id)}]${h.audience === "agent" ? " (agent)" : ""}`
    : `[context] ${h.id}`;
  return `${where}\n  ${h.snippet}`;
};

/** One item in full: the header line, its dependencies, then its body (the prose the viewer's detail pane
 *  shows). The parent is not printed separately - a dotted ref already names it (`MCP-3.1` -> `MCP-3`). */
function fmtItemDetail(detail: ItemDetail): string {
  const lines = [fmtItem(detail.item)];
  // A deleted item still resolves by ref on purpose: a body or comment that mentions it should read as
  // "deleted", not as a broken reference. Say so at the top, or the rest of the reply looks live.
  if (detail.item.deletedAt !== null) lines.push(`deleted at ${detail.item.deletedAt} (kept for reference; the ref is not reused)`);
  if (detail.deps.length > 0) lines.push(`depends on: ${detail.deps.join(", ")}`);
  if (detail.item.body) lines.push("", detail.item.body);
  // After the body: the body is the item's settled description, the comments are what happened while working
  // on it. Reading them in that order is reading the plan and then the history.
  if (detail.comments.length > 0) {
    lines.push("", "## Comments");
    for (const n of detail.comments) lines.push(`- ${fmtComment(n)}`);
  }
  return lines.join("\n");
}

/** One comment, led by the short id so it can be passed straight back to `edit_comment` / `delete_comment`. */
const fmtComment = (n: Comment, ref?: string): string =>
  `${shortCommentId(n.id)} ${n.createdAt} ${ref ? `[${ref}] ` : ""}${n.body}${n.audience === "agent" ? " (mine)" : ""}`;

/**
 * The context pack as readable markdown - what a returning session opens with.
 *
 * **Every part is rendered by the formatter its own tool uses** (`CTX-4`): `fmtProject` for the header,
 * `fmtItem` for the board, `fmtHeadings` for the table of contents, and the protocol as its own raw content.
 * That is what makes this a composition rather than a fifth rendering of the same rows, and it means
 * improving one of those improves the pack for free.
 */
function fmtPack(pack: ContextPack): string {
  const lines = [fmtProject(pack.project)];
  // The protocol leads (CTX-9): a session must see how to operate before anything else it is told.
  if (pack.protocol !== null) lines.push("", `## ${PROTOCOL_HEADING}`, pack.protocol);
  if (pack.sectionHeadings.length > 0) lines.push("", "## Context sections", fmtHeadings(pack.sectionHeadings));
  lines.push("", ...fmtBoard(pack.board));
  lines.push("", fmtHeld(pack));
  return lines.join("\n");
}

/**
 * The board: either every open item, or the two groups a session acts on (`PROJ-8`).
 *
 * **Two headed groups rather than one merged list**, because they answer different questions - in-progress is
 * "where was I", next is "what did we agree" - and a merged list loses which is which.
 *
 * A blocked item is **annotated, not withheld**: wanting to do something before it is unblocked is a real
 * intention, and usually the reason to go unblock the dependency. The pack says so on the line rather than
 * quietly reordering around it.
 */
function fmtBoard(board: PackBoard): string[] {
  if (board.kind === "full") {
    return ["## Open items", board.items.length > 0 ? board.items.map(fmtItem).join("\n") : "(none)"];
  }
  const lines: string[] = [];
  if (board.inProgress.length > 0) lines.push(`## In progress (${board.inProgress.length})`, board.inProgress.map(fmtItem).join("\n"), "");
  if (board.next.length > 0) {
    lines.push(`## Next (${board.next.length})`, board.next.map((n) => `${fmtItem(n)}${fmtBlockers(n.blockedBy)}`).join("\n"), "");
  }
  // Nothing in flight and no agreed order, on a board too big to carry: say so rather than print a heading
  // over nothing. `fmtHeld` still names the count and the tool, so this is not a dead end.
  if (lines.length === 0) lines.push("## Board", `nothing in progress, and no order recorded - set one with set_next, or list the backlog with list_items`);
  // Only in the trimmed case, and that is the point: while the full listing is carried it already shows every
  // area, so this would be a second copy. Once it is replaced, nothing else says that CAL or SCHED exist.
  if (board.areas.length > 0) lines.push("## Areas", fmtAreas(board.areas), "");
  return lines.filter((line, index) => !(line === "" && index === lines.length - 1));
}

/**
 * The line that names what the pack left out, and the tool that reaches each thing.
 *
 * **Load-bearing, not a courtesy.** The pack went from 55kB to roughly 8kB by holding back section bodies and
 * comments entirely, and both recorded retrieval failures (`MCP-24`) were an agent that had the information
 * available and did not think to ask for it. An agent that does not know to look is therefore the exact
 * failure this trim would otherwise cause, and `CTX-4`'s standing rule is that what is not shown is always
 * announced rather than silently dropped.
 *
 * Phrased as counts and tool names because that is what makes it actionable: "31 comments" plus the tool that
 * reads them is a decision the model can take, where "some detail is omitted" is not.
 */
const fmtHeld = (pack: ContextPack): string => {
  const { held, board } = pack;
  // "More open items", never "items": the list above is a *partial* view of the same set, unlike comments,
  // which are held back entirely. A count that silently overlaps what was just printed gets misread once and
  // then distrusted.
  const items =
    board.kind === "trimmed" && board.held.total > 0
      ? `- ${board.held.total} more open item${board.held.total === 1 ? "" : "s"} (${board.held.byStatus.map((s) => `${s.count} ${s.status}`).join(", ")}) - list_items, by area or status`
      : null;
  return [
    "---",
    "Not shown here, and worth reaching for rather than re-deriving:",
    items,
    held.sections > 0 ? `- ${held.sections} context section${held.sections === 1 ? "" : "s"}, named above - open one with get_context` : null,
    held.comments > 0 ? `- ${held.comments} comment${held.comments === 1 ? "" : "s"} - list_comments, or search_plan` : null,
    "- item bodies, where most of the reasoning is - get_item, or search_plan across all of it",
  ]
    .filter((line) => line !== null)
    .join("\n");
};

/**
 * Resolve the `project` every tool requires. It stays required deliberately (MCP-14): defaulting it when a
 * store holds exactly one project would make a tool's behaviour depend on a global that `create_project` can
 * change mid-session, leaving an agent that never learned the key with no way back.
 *
 * What makes that cost nothing is this error. Naming the keys collapses "wrong key" and "do not know the key"
 * into one self-correcting call, instead of making `list_projects` a ritual at the top of every session.
 */
async function resolveProject(db: Database, caller: Caller, key: string): Promise<OwnedProject> {
  const project = await getProjectByKey(db, caller.ownerId, key);
  if (project !== null) return project;
  const keys = (await listProjects(db, caller.ownerId)).map((p) => p.key);
  if (keys.length === 0) throw new Error("this store has no projects yet - create one with create_project");
  throw new Error(`no project with key "${key}".${suggest(key, keys, "list_projects")}`);
}

/** The same courtesy for a item ref (MCP-14), built only on the failure path so a successful call never pays
 *  for the listing. Bounded, unlike the project keys: a real backlog has hundreds of refs. */
async function noSuchRef(db: Database, project: OwnedProject, ref: string): Promise<Error> {
  const refs = (await listItems(db, { projectId: project.id })).map((i) => i.ref);
  return new Error(`no item "${ref}" in ${project.key}.${suggest(ref, refs, "list_items")}`);
}

/** Resolve a ref before handing it to a mutation. The domain keeps its own guard - this one exists so the
 *  reply can say what the ref might have been, which the domain cannot phrase because the answer names tools.
 *  One extra select, on a path that already opens a transaction. */
async function resolveRef(db: Database, project: OwnedProject, ref: string): Promise<Item> {
  const item = await getItem(db, project.id, ref);
  if (item === null) throw await noSuchRef(db, project, ref);
  return item;
}

/** And for a context heading, where the headings are free text and therefore the easiest thing to half-remember. */
async function noSuchSection(db: Database, project: OwnedProject, heading: string): Promise<Error> {
  const headings = (await listSections(db, project.id)).map((s) => s.heading);
  return new Error(`no context section "${heading}" in ${project.key}.${suggest(heading, headings, "list_context")}`);
}

/**
 * The notice a reply carries when the plan was reloaded from disk during the call (IMP-10).
 *
 * Said rather than done silently, for the reason `MCP-21` gives: derived state changed under the reader. A
 * session that listed items ten minutes ago is holding refs, statuses and counts from a plan that no longer
 * exists, and nothing else in the answer would reveal it - the reply looks exactly like a normal one.
 */
const RELOADED =
  "NOTE: the plan file changed on disk and was reloaded (a git pull, a branch switch, a hand edit, or another " +
  "apm server). Anything you read from this project earlier in the session may be out of date - re-read it " +
  "before relying on it.";

const withNotice = (result: CallToolResult): CallToolResult => ({
  ...result,
  content: [{ type: "text", text: RELOADED }, ...result.content],
});

/**
 * Whether a tool reads or writes, declared on the wire rather than left for a client to infer from the name.
 *
 * Nothing local reads these - Claude Desktop and Claude Code call what they are told to. They matter to
 * *other* clients, which use `readOnlyHint` to decide what may be cached, replayed or retried. A page holding
 * an artifact `mcp` grant is the concrete case: an annotated read becomes cacheable and can be shared across
 * sections, while a declared write can never be cached or re-executed by cache machinery. An unannotated
 * tool gets the safe treatment (no caching) and so is never *wrong*, only inert - which is why this is worth
 * doing now, while the surface is 22 tools and one file, rather than after something depends on it.
 *
 * `open_viewer` counts as a write despite touching no data: it binds a port, so re-executing it is not free.
 */
/**
 * The server's `instructions`, handed to the client at initialize and surfaced to the model **before any tool
 * is called**. Two sentences of orientation, and it is the only non-circular place to put them.
 *
 * **Why this is not simply the protocol section's job.** Each project keeps its operating manual in its
 * `protocol` section, which `get_project` returns first - but a model only reads that after deciding to call
 * `get_project`, so "the protocol matters" stated inside the protocol reaches nobody who has not already
 * arrived. The same circularity applied to `get_project` itself: its description says it is the best first
 * call, and a description is read while scanning twenty tools rather than while deciding what to do.
 *
 * **Deliberately short, and deliberately not a tool inventory.** The client already has every tool's name,
 * description and input schema, so restating them here would spend the one piece of always-on context on
 * something already supplied. What the model cannot infer is the *order*: read the project before acting,
 * apply what the protocol says, and search before concluding nothing was written down.
 */
const INSTRUCTIONS = [
  "Durable project memory: the plan, the reasoning behind it, and the record of what was decided.",
  "",
  "An **item** is anything you work on or keep up - work to ship, a skill to practise, a plant to water - and they share one set of tools, because what varies is whether an item carries a schedule, never what kind of thing it is. Comments, context sections and measurements are separate layers, not items.",
  "",
  "Call `get_project` before acting, and again whenever you have lost track of where things stand: an ordinary read, not a session that opens once. Its `protocol` section comes first and is the project's operating manual - apply it rather than merely noting it.",
  "",
  "What it returns is an index. Item bodies, context sections and comments are named but not carried, and the reply says which tool reaches each. Most of what has been decided lives in that prose rather than in any title, so `search_plan` before designing anything or filing an item: re-deriving a decision already recorded is how a plan ends up holding the weaker version of it.",
  "",
  "Write as you go. A conversation is abandoned rather than closed, so there is no end to save anything for.",
].join("\n");

const READ = { readOnlyHint: true } as const;
const WRITE = { readOnlyHint: false } as const;

/**
 * `store` is the seam between the transport layer and persistence, injected so the domain and tests stay
 * unaware of it: `persist` writes the store through to YAML after a mutation (the durability), and `refresh`
 * picks up a change made to the file by something else before the call reads anything.
 */
export { INSTRUCTIONS };

export function registerTools(server: McpServer, db: Database, store: StoreAccess, viewer: ViewerHost, caller: Caller): void {
  /**
   * What wraps every handler's own work: refresh first, then run it, then turn anything thrown into readable
   * text rather than a stack trace.
   *
   * A wrapper rather than a line inside each handler, because forgetting it would be invisible - the tool
   * would answer confidently from a database that no longer matches the file, which is the exact failure
   * `IMP-10` exists to close. Handlers therefore throw freely and never catch.
   */
  const guarded = async (work: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    let reloaded = false;
    try {
      reloaded = await store.refresh();
      const result = await work();
      return reloaded ? withNotice(result) : result;
    } catch (error) {
      // The notice still rides on a failure: a call that failed *because* the plan moved under it is the case
      // where knowing the plan moved matters most.
      const failed = errorText(message(error));
      return reloaded ? withNotice(failed) : failed;
    }
  };

  server.registerTool(
    "create_project",
    {
      annotations: WRITE,
      description:
        'Create a project. `key` is a short unique handle (e.g. "apm"); `type` is open ("software", "learning", ...). ' +
        "Seeds a starter `protocol` section that ends with an onboarding interview: read it back (get_project), " +
        "ask the user those questions, and write the answers in with set_direction, create_item and set_context " +
        "before moving on, so the project is usable from its next session rather than empty.",
      inputSchema: { key: z.string(), name: z.string(), type: z.string(), direction: z.string().optional() },
    },
    async ({ key, name, type, direction }): Promise<CallToolResult> =>
      guarded(async () => {
        const project = await createProjectWithDefaults(db, { key, name, type, direction, ownerId: caller.ownerId }, ACTOR);
        await store.persist();
        return text(`created project:\n${fmtProject(project)}`);
      }),
  );

  server.registerTool(
    "list_projects",
    {
      annotations: READ,
      description: "List all projects.",
      inputSchema: {},
      /**
       * A list of records (`MCP-26`), and the clearest case of that rule yet: the text form separates fields
       * with " - " and "( )", which a project named "Spanish - B2" makes ambiguous - where `list_items`'
       * brackets at least bound the field that can vary. `direction` is prose, but it is one sentence rather
       * than a document, so JSON-escaping it loses nothing `get_item` would have lost.
       *
       * The pair matters too: anything drawing a board picks a project first, so structured items beside a
       * regex-only project picker would be half a job.
       */
      outputSchema: {
        projects: z.array(
          z.object({
            key: z.string().describe("The short handle every other tool takes as `project`."),
            name: z.string(),
            type: z.string().describe('Open vocabulary: "software", "learning", ...'),
            direction: z.string().nullable().describe("The running north-star statement, where one is set."),
          }),
        ),
      },
    },
    async (): Promise<CallToolResult> =>
      guarded(async () => {
        const projects = await listProjects(db, caller.ownerId);
        return {
          ...text(projects.length ? projects.map(fmtProject).join("\n") : "no projects yet"),
          // Derived from the same rows as the text, in the same call, so the two cannot drift (MCP-26).
          structuredContent: { projects: projects.map((p) => ({ key: p.key, name: p.name, type: p.type, direction: p.direction })) },
        };
      }),
  );

  server.registerTool(
    "set_direction",
    {
      annotations: WRITE,
      description: "Set or revise a project's running direction (its north-star statement).",
      inputSchema: { project: z.string(), direction: z.string() },
    },
    async ({ project, direction }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        const updated = await setDirection(db, p.id, direction, ACTOR);
        await store.persist();
        return text(`direction set:\n${fmtProject(updated)}`);
      }),
  );

  server.registerTool(
    "list_areas",
    {
      annotations: READ,
      description:
        "List a project's areas - the ref prefixes items are grouped under - with what each is called and how " +
        "many items in it are open. The map of a project: use it to pick an area, then list_items(area:) to " +
        "read it. Areas are open-ended, so creating an item with a new prefix creates the area; one that " +
        "nobody has named yet is listed with no name rather than omitted.",
      inputSchema: { project: z.string() },
      outputSchema: {
        areas: z.array(
          z.object({
            key: z.string().describe('The ref prefix, e.g. "MCP". This is what list_items takes as `area`.'),
            name: z.string().nullable().describe("Null for an area that exists only because an item uses the prefix."),
            open: z.number().int().describe("Items not done and not deleted."),
            total: z.number().int(),
          }),
        ),
      },
    },
    async ({ project }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        const list = await listAreas(db, p.id);
        return {
          ...text(list.length ? fmtAreas(list) : `no items in ${p.key} yet, so no areas`),
          // Derived from the same rows as the text, in the same call, so the two cannot drift (MCP-26).
          structuredContent: { areas: list },
        };
      }),
  );

  server.registerTool(
    "record_measurements",
    {
      annotations: WRITE,
      description:
        "Record dated readings: a weight, a meal's macros, a set of an exercise, a night's sleep. " +
        "A *metric* is the name of a series (\"body_weight\") and there is one of it; a *measurement* is one dated " +
        "reading of that metric and there are thousands. So you record measurements, and you list metrics. Numbers go " +
        "in `value`, categoricals in `text` ('restless'), one or the other per reading. " +
        "**Pass `group` whenever the readings belong to one occurrence** - a meal, a workout, a day - and they " +
        "are written nested under it in this single call, which costs no more than a flat list. Nesting is " +
        "what lets you later ask which calories were in which meal; `label` is a display name and is never " +
        "grouped by, so if you want to total by something, it needs to be a `group`. " +
        "`at` is when it was MEASURED, not now, so a backfilled log passes the day it is about. " +
        "Readings are not items: they never appear on the board and carry no status.",
      inputSchema: {
        project: z.string(),
        readings: z
          .array(
            z.object({
              metric: z.string().describe('What was measured, e.g. "kcal", "body_weight", "sleep_quality". Reuse a name to build a series.'),
              value: z.number().describe("The reading, when it is a number.").optional(),
              text: z.string().describe("The reading, when it is categorical. Give this or `value`, never both.").optional(),
              unit: z.string().describe('e.g. "kg", "g", "min". Keep one unit per metric or nothing can plot it.').optional(),
              label: z.string().describe("Display name only. Never aggregated - if you would group by it, use `group` instead.").optional(),
              source: z.string().describe('How it was arrived at: "labelled", "estimated", "scale".').optional(),
              at: z.string().describe("Overrides the call's `at` for this reading alone. Same format.").optional(),
            }),
          )
          .describe("The readings. All of them share the subject, the time and the group."),
        ref: z.string().describe("The item these are about. Omit for a reading about the project itself (body weight, daily calories).").optional(),
        at: z.string().describe("When it was MEASURED, not now: an ISO-8601 instant (2026-08-14T08:00:00Z) or a plain day (2026-08-14), in UTC. Defaults to now.").optional(),
        group: z
          .object({
            metric: z.string().describe('The occurrence, e.g. "meal", "workout", "day".'),
            label: z.string().describe('What it was, e.g. "overnight oats".').optional(),
            source: z.string().optional(),
          })
          .describe("An occurrence to nest the readings under. It holds no reading of its own.")
          .optional(),
        parent: z.string().describe("Nest under an existing measurement id, for a tree deeper than one call builds.").optional(),
      },
    },
    async ({ project, readings, ref, at, group, parent }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        const item = ref === undefined ? null : await resolveRef(db, p, ref);
        const rows = await recordMeasurements(db, { projectId: p.id, itemId: item?.id ?? null, at, group, parentId: parent, readings }, ACTOR);
        // Appended to the month files, NOT persisted through the plan: these rows are deliberately kept out
        // of it, and re-serialising a plan to record one number is the cost the split exists to avoid.
        await store.appendMeasurements(await toRecords(db, p.key, rows));
        const root = rows[0]!;
        return text(`recorded ${rows.length} at ${root.at}${ref ? ` on ${ref}` : ""}:\n${fmtRecorded(rows)}\n\nid: ${root.id}`);
      }),
  );

  server.registerTool(
    "list_metrics",
    {
      annotations: READ,
      description:
        "What this project measures: every metric name (the series, not the readings), how many measurements " +
        "each has, and the units in use. " +
        "The vocabulary is discovered from the data rather than declared, so this is what to call before " +
        "query_measurements - and before inventing a name, since reusing an existing one is what makes a series.",
      inputSchema: { project: z.string() },
      outputSchema: {
        metrics: z.array(
          z.object({
            metric: z.string(),
            count: z.number().int(),
            units: z.array(z.string()).describe("More than one means the series is not directly comparable."),
          }),
        ),
      },
    },
    async ({ project }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        const list = await listMetrics(db, p.id);
        const body = list
          .map((m) => `${m.metric} - ${m.count} reading${m.count === 1 ? "" : "s"}${m.units.length > 0 ? ` (${m.units.join(", ")})` : ""}`)
          .join("\n");
        return { ...text(list.length ? body : `nothing measured in ${p.key} yet`), structuredContent: { metrics: list } };
      }),
  );

  server.registerTool(
    "query_measurements",
    {
      annotations: READ,
      description:
        "A metric's series, aggregated into buckets over a window. Returns a shape (down, flat, up) rather " +
        "than a pile of points, which is what makes it safe to call with a year of data. " +
        "Every unit found in the window comes back too: more than one means the numbers are not comparable " +
        "and must not be trended without converting them. " +
        "Aggregation is flat - it never walks the tree - so a total is the same whether the readings were " +
        "nested under an occurrence or recorded loose.",
      inputSchema: {
        project: z.string(),
        metric: z.string().describe("From list_metrics."),
        ref: z.string().describe("Narrow to one item's readings. Omit for every subject; pass `project` to get only project-level ones.").optional(),
        from: z.string().describe("ISO-8601 UTC, inclusive.").optional(),
        to: z.string().describe("ISO-8601 UTC, inclusive.").optional(),
        bucket: z.enum(["day", "week", "month"]).describe("Defaults to day.").optional(),
        aggregate: z.enum(["sum", "avg", "min", "max", "count"]).describe("Defaults to sum. Use count for a categorical metric.").optional(),
      },
    },
    async ({ project, metric, ref, from, to, bucket, aggregate }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        // "project" is the one ref that names the project itself rather than an item, so a caller can ask for
        // body weight without it being confused with a reading on some item.
        const itemId = ref === undefined ? undefined : ref === "project" ? null : (await resolveRef(db, p, ref)).id;
        const series = await aggregateSeries(db, { projectId: p.id, metric, itemId, from, to }, { bucket, aggregate });
        const header = `${metric}, ${aggregate ?? "sum"} by ${bucket ?? "day"}${series.points.length === 0 ? " - nothing in that window" : ""}`;
        const mixed = series.units.length > 1 ? `\nWARNING: this window mixes ${andList(series.units)}, so these numbers are not comparable.` : "";
        // A categorical series asked a numeric question comes back as a column of blanks, because Postgres
        // answers sum(NULL) with NULL rather than an error - which reads as "no data" when it means "wrong
        // question". Said rather than left to the description, since a description is what CTX-2 measured
        // being ignored 64 times out of 64.
        const wrongAggregate =
          (aggregate ?? "sum") !== "count" && series.numericReadings === 0 && series.points.length > 0
            ? `\nNOTE: "${metric}" has no numeric readings in this window, so ${aggregate ?? "sum"} is empty. It is a categorical metric - use aggregate "count" to trend how often it was recorded.`
            : "";
        const body = series.points.map((point) => `${point.at.slice(0, 10)}  ${point.value ?? "-"}  (${point.n})`).join("\n");
        return text(`${header}${mixed}${wrongAggregate}${series.points.length > 0 ? `\n${body}` : ""}`);
      }),
  );

  server.registerTool(
    "set_next",
    {
      annotations: WRITE,
      description:
        "Record the order to work in: a short list of item refs, most important first. Replaces the whole " +
        "list (pass [] to clear it), because a list you can only append to is one nobody re-examines. " +
        "Keep it to five or ten - the shortness is what forces \"does this beat what is already third?\", " +
        "which is what produces an ordering at all. This is a stated intention, not a constraint: it does " +
        "not gate anything, and an item whose dependencies are unmet is flagged rather than refused. " +
        "get_project reads it back, so this is how an agreed order survives the conversation that produced it.",
      inputSchema: {
        project: z.string(),
        refs: z.array(z.string()).describe("Item refs in the order to work on them. Replaces the whole list; pass [] to clear it."),
      },
    },
    async ({ project, refs }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        const list = await setNext(db, p.id, refs, ACTOR);
        await store.persist();
        // Written and shown can differ: a `done` ref is stored but filtered out of every read, and letting
        // that pass silently would look like the write dropped it.
        const dropped = refs.length - list.length;
        return text(
          [
            list.length > 0 ? `next, in order:\n${fmtNext(list)}` : "next: cleared",
            dropped > 0 ? `(${dropped} ref${dropped === 1 ? "" : "s"} stored but not shown: already done, in review, or deleted)` : null,
          ]
            .filter((line) => line !== null)
            .join("\n"),
        );
      }),
  );

  server.registerTool(
    "create_item",
    {
      annotations: WRITE,
      description:
        "Create a item. Give exactly one of `area` (allocates the next ref in it, e.g. MCP-7), `parent` " +
        "(allocates the next sub-item beneath that ref, e.g. MCP-3.2), or `ref` (takes that exact ref, for " +
        "migrating an existing id scheme or for referring to it before it exists).",
      inputSchema: {
        project: z.string(),
        area: z.string().describe('The ref prefix to allocate under, e.g. "MCP".').optional(),
        parent: z.string().describe("Create as the next sub-item of this ref. Nesting comes from the ref itself.").optional(),
        ref: z.string().describe("Take exactly this ref (e.g. MCP-7 or MCP-3.2) instead of allocating the next one.").optional(),
        title: z.string(),
        body: z.string().describe("The item's description, in markdown.").optional(),
        status: z.enum(STATUS_VALUES).describe("Defaults to to-do.").optional(),
        deps: DEPS,
        start: date("When work on it is planned to begin. Optional; most items have no dates").optional(),
        due: date("When it is due. Optional; most items have no dates").optional(),
      },
    },
    async ({ project, area, parent, ref, title, body, status, deps, start, due }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        const item = await createItem(db, { projectId: p.id, area, parent, ref, title, body, status, deps, start, due }, ACTOR);
        await store.persist();
        return text(`created ${fmtItem(item)}${deps?.length ? `\ndepends on: ${deps.join(", ")}` : ""}`);
      }),
  );

  server.registerTool(
    "list_items",
    {
      annotations: READ,
      description:
        "List items in a project, optionally filtered by area or status. Leads with a count of what matched, and of the project as a whole when a filter narrowed it. " +
        "An item is anything you work on or keep up: work to ship, a skill to practise, a plant to water. What varies is whether it carries a schedule, not what kind of thing it is.",
      inputSchema: { project: z.string(), area: z.string().optional(), status: z.enum(STATUS_VALUES).optional() },
      /**
       * The board, as records (`MCP-26`). This is the reply the artifact report was actually about: something
       * rendering every item wants ref, status, title and the edges, and wants none of the prose.
       *
       * **The shape is `RoadmapItem` from `scripts/items.ts`**, not a new one invented here. That interface is
       * already the shared item model - Node-free, and what the viewer's graph is built on - so a browser
       * consumer gets the type it already has rather than a second shape to reconcile. `id` rather than `ref`
       * for the same reason: the shared model calls it that.
       *
       * `parent` is derived from the ref by the dotted rule (`MCP-3.1` -> `MCP-3`) rather than read from
       * `items.parent_id`, because the column holds a uuid and every other field here is a ref. Nesting comes
       * from the id by design, so deriving it is the definition rather than a shortcut.
       */
      outputSchema: {
        total: z.number().int().describe("Items in the project as a whole, before any filter."),
        items: z.array(
          z.object({
            id: z.string().describe('The ref, e.g. "MCP-3" or "MCP-3.1".'),
            area: z.string(),
            status: z.enum(STATUS_VALUES),
            title: z.string(),
            deps: z.array(z.string()).describe("Refs this item depends on."),
            parent: z.string().nullable().describe("Parent ref for a nested item, from the dotted id."),
            start: z.string().nullable().describe("Planned start, YYYY-MM-DD, or null."),
            due: z.string().nullable().describe("Due date, YYYY-MM-DD, or null."),
          }),
        ),
      },
    },
    async ({ project, area, status }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        const list = await listItems(db, { projectId: p.id, area, status });
        // A count, because a listing that only returns lines lets a total carried in a comment or in working
        // memory drift for a whole session with nothing ever contradicting it (MCP-21). The unfiltered total
        // rides along whenever a filter was applied: "12 items" and "12 of 116" are different facts, and
        // only the second is safe to write down.
        const filtered = area !== undefined || status !== undefined;
        // `countItems`, not a second listing: this is one integer, and building 151 rows to read `.length`
        // was the same waste as selecting bodies nobody reads.
        const total = filtered ? await countItems(db, { projectId: p.id }) : list.length;
        const scope = [status, area].filter(Boolean).join(" ");
        const header = `${list.length} ${scope ? `${scope} ` : ""}item${list.length === 1 ? "" : "s"}${filtered ? ` of ${total} in ${p.key}` : ` in ${p.key}`}`;
        const deps = await dependencyRefsByItem(db, p.id);
        return {
          content: [{ type: "text", text: list.length ? `${header}\n${list.map(fmtItem).join("\n")}` : `${header} - nothing matches` }],
          structuredContent: {
            total,
            items: list.map((i) => ({
              id: i.ref,
              area: i.areaKey,
              status: i.status,
              title: i.title,
              deps: deps.get(i.id) ?? [],
              parent: parentRef(i.ref),
              start: i.startOn,
              due: i.dueOn,
            })),
          },
        };
      }),
  );

  server.registerTool(
    "get_item",
    {
      annotations: READ,
      description:
        "Read one item in full by its ref: status, title, dependencies, its body (the prose the viewer's detail pane shows), and any comments recorded against it. Use list_items to find the ref.",
      inputSchema: { project: z.string(), ref: z.string() },
    },
    async ({ project, ref }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        const detail = await getItemDetail(db, p.id, ref);
        if (detail === null) throw await noSuchRef(db, p, ref);
        // Prose, and deliberately **not** an `outputSchema` (`MCP-26`). One was tried here on 2026-09-01 and
        // reverted once the measurement came in: declaring a schema does not add structure alongside the text,
        // it *replaces* it, and this reply is a document rather than a record - a body of markdown, meant to be
        // read. JSON-escaping 10kB of prose costs 2-4% more and buys a consumer nothing it wanted.
        //
        // The board case that prompted the report is `list_items`, which is a list of records and carries the
        // schema instead. That is the line: **structure for a list of records, prose for a document.**
        return text(fmtItemDetail(detail));
      }),
  );

  server.registerTool(
    "set_status",
    {
      annotations: WRITE,
      description: `Change a item's status. One of: ${STATUS_VALUES.join(", ")}.`,
      inputSchema: { project: z.string(), ref: z.string(), status: z.enum(STATUS_VALUES) },
    },
    async ({ project, ref, status }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        await resolveRef(db, p, ref);
        const item = await setStatus(db, { projectId: p.id, ref, status }, ACTOR);
        await store.persist();
        return text(`updated ${fmtItem(item)}`);
      }),
  );

  server.registerTool(
    "edit_item",
    {
      annotations: WRITE,
      description:
        "Revise a item's title, body (its prose - the design, rationale or a note on why it moved), its dependencies and/or its planned start and due dates. " +
        "Pass only the fields to change; status has its own tool (set_status).",
      inputSchema: {
        project: z.string(),
        ref: z.string(),
        title: z.string().optional(),
        body: z.string().describe("The item's description, in markdown.").optional(),
        deps: DEPS,
        start: date("When work on it is planned to begin; null clears it").nullable().optional(),
        due: date("When it is due; null clears it").nullable().optional(),
      },
    },
    async ({ project, ref, title, body, deps, start, due }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        await resolveRef(db, p, ref);
        // Dep refs are resolved here as well as in the domain, so an unknown one is answered with near misses
        // rather than the domain's bare "no item X" - the same courtesy MCP-14 gives the item's own ref.
        // Local refs only: a scoped ref names another project (`PROJ-11`), so this project's ref list is the
        // wrong thing to suggest, and an unresolved one is valid by design. `setDependencies` owns that case,
        // including the error for a scoped ref whose project *is* loaded and lacks it.
        for (const dep of deps ?? []) if (splitScope(dep) === null) await resolveRef(db, p, dep);
        const item = await editItem(db, { projectId: p.id, ref, title, body, deps, start, due }, ACTOR);
        await store.persist();
        return text(`edited ${fmtItem(item)}${deps ? `\ndepends on: ${deps.length ? deps.join(", ") : "(nothing)"}` : ""}`);
      }),
  );

  server.registerTool(
    "delete_item",
    {
      annotations: WRITE,
      description:
        "Delete a item. Soft: the item and its history stay in the event log, its ref is never reused, and dependency " +
        "edges to and from it are dropped. Refuses if it still has sub-items.",
      inputSchema: { project: z.string(), ref: z.string() },
    },
    async ({ project, ref }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        await resolveRef(db, p, ref);
        const item = await deleteItem(db, { projectId: p.id, ref }, ACTOR);
        await store.persist();
        return text(`deleted ${fmtItem(item)}\nIt is out of the plan but not gone: the event log keeps it, and ${item.ref} will not be reused.`);
      }),
  );

  server.registerTool(
    "get_project",
    {
      annotations: READ,
      /**
       * **Named for what it reads, not for a moment (`CTX-10`).** This was `resume_project`, and that name
       * outlived the thing it described. It implied a *session* being opened - which is exactly the concept
       * removed here - and implied a once-per-conversation ritual, which is not how it works. Nothing about
       * it is stateful: it is a read, and calling it again mid-conversation, after a refactor or after losing
       * the thread, is the obviously right thing to do. The old name quietly discouraged that.
       *
       * `get_project` also puts it in the pattern the rest of the surface already uses. `get_item` returns
       * a item with its dependencies and comments, so `get_project` returns a project with its protocol,
       * its board and its section headings: one level up, same shape.
       */
      description:
        "Read a project at a glance: its direction, its protocol, every open item, and the headings of its context sections. " +
        "The best first call on a project, and worth calling again any time you have lost track of where things stand. Apply the `protocol` section (returned first) before acting. " +
        "It is an index, not the whole plan - most of what has been decided lives in item bodies and comments, which it names rather than carries. " +
        "The reply ends with what it is holding back and which tool reaches each thing; reach for search_plan before re-deriving anything.",
      inputSchema: { project: z.string() },
    },
    async ({ project }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        // The stamp goes here as well as on open_viewer because staleness is not a viewer problem: this is the
        // first call of a session, so it is the moment anyone would act on "this process predates the code".
        return text(`${fmtPack(await resumeProject(db, p.id))}\n\n---\n${buildStamp()}`);
      }),
  );

  server.registerTool(
    "search_plan",
    {
      annotations: READ,
      // Instructional only, and deliberately free of this repo's own refs and history: every apm user reads
      // this, on every project, and a item number from the tool's own backlog means nothing to someone
      // tracking houseplants. The evidence for why the "when" clause is worded so strongly lives on `MCP-24`.
      //
      // The "when" is the load-bearing half. Both recorded failures were an agent that had the information
      // available and did not think to ask for it, and a description that only describes cannot fix that.
      description:
        "Search this project's written record - item bodies, comments and context sections - for ranked snippets with each hit's ref. " +
        "**Reach for this before designing anything non-trivial, and before filing a item.** Most of what a project has decided lives in its prose rather than its titles, so list_items cannot find it. " +
        "Snippets rather than documents, so a search that finds nothing costs almost nothing and speculative searching is safe. Open what looks relevant with get_item or list_comments. " +
        "Accepts \"quoted phrases\", and -word to exclude.",
      inputSchema: {
        project: z.string(),
        query: z.string().describe('Words to look for. Stemmed, so "rendering" finds "rendered".'),
        limit: z.number().int().positive().optional().describe(`Defaults to ${SEARCH_LIMIT}.`),
      },
      /**
       * The best candidate for a schema of any tool here (`MCP-26`), for a reason that only became clear once
       * `get_item` was measured: a schema does not *add* structure, it **replaces** the prose. That is a bad
       * trade wherever the prose was composed to be read, and no trade at all here - these hits are already a
       * typed `SearchHit[]` in the domain layer, flattened to text purely for display, and every field a caller
       * wants (ref, rank, source, whether the search was relaxed) is a field rather than a sentence.
       *
       * `relaxed` earns its place in the structure rather than only in the prose: it is the one thing a caller
       * must not miss, since a relaxed hit matched some of the query and reads exactly like one that matched
       * all of it.
       */
      outputSchema: {
        query: z.string(),
        relaxed: z.boolean().describe("True when no document contained every term and the search was widened to any of them."),
        hits: z.array(
          z.object({
            source: z.enum(["item", "comment", "context"]),
            id: z.string().describe("The ref, comment id or heading that addresses this hit."),
            ref: z.string().nullable().describe("The item this hit is about, where there is one."),
            title: z.string().nullable(),
            snippet: z.string().describe("Matching passage, matched terms wrapped in **."),
            rank: z.number(),
            audience: z.string().nullable().describe('"agent" for Claude\'s own working comments.'),
            at: z.string(),
          }),
        ),
      },
    },
    async ({ project, query, limit }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        const { hits, relaxed } = await search(db, p.id, query, limit);
        // A miss is a real answer and worth stating as one - "nothing is recorded about this" is exactly what
        // the caller wanted to know before designing.
        //
        // The nudge names the actual cause, which is **term density, not length** (measured 2026-09-01): stop
        // words are stripped before the AND applies, so an English question collapses to two or three terms
        // and matches fine, while a list of nouns keeps all of them and cannot. Saying "every word has to
        // appear in the same document" is both the mechanism and the fix, in one clause.
        //
        // With the structured half too, and an empty `hits`: a tool that declares an output schema must send
        // structured content on every success, or the SDK turns the reply into an error - which is what a miss
        // was until a consumer reported it (`MCP-30`), and an error is the one reading a miss must never have.
        if (hits.length === 0) {
          return {
            ...text(`no matches for "${query}".\nIf that is surprising, try fewer or more distinctive words - every word has to appear in the same document.`),
            structuredContent: { query, relaxed, hits: [] },
          };
        }
        // Said out loud when the fallback fired, because the caller's precision silently dropped: these hits
        // contain *some* of the terms, not all, so a weak one should not read like a strong one.
        const how = relaxed
          ? `no document contains all of "${query}", so these match some of it, best first`
          : `${hits.length} hit${hits.length === 1 ? "" : "s"} for "${query}", best first`;
        return {
          content: [{ type: "text", text: `${how}:\n\n${hits.map(fmtHit).join("\n\n")}` }],
          structuredContent: { query, relaxed, hits: hits.map((h) => ({ ...h, id: h.source === "comment" ? shortCommentId(h.id) : h.id })) },
        };
      }),
  );

  server.registerTool(
    "list_context",
    {
      annotations: READ,
      description:
        "List the headings of a project's context sections - a table of contents for the living narrative. Read one with get_context.",
      inputSchema: { project: z.string() },
    },
    async ({ project }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        const sections = await listSections(db, p.id);
        return text(sections.length ? fmtHeadings(sections.map((s) => s.heading)) : "no context sections yet");
      }),
  );

  server.registerTool(
    "get_context",
    {
      annotations: READ,
      description:
        "Read one context section by its exact heading, so it can be revised from its current content. Use list_context to see the headings; get_project already returns `protocol` in full.",
      inputSchema: { project: z.string(), heading: z.string() },
    },
    async ({ project, heading }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        const section = await getSection(db, p.id, heading);
        if (section === null) throw await noSuchSection(db, p, heading);
        return text(`### ${section.heading}\n${section.content}`);
      }),
  );

  server.registerTool(
    "set_context",
    {
      annotations: WRITE,
      description:
        'Set or revise a named context section (e.g. "Goals", "Assumptions", "Open questions"). Writing the same heading again replaces its content, keeping its position. ' +
        "This is the project's living narrative, distinct from the one-line direction, and the order is the order a reader takes them in - so place a section deliberately with `after`. " +
        "The `protocol` section is an ordinary section written through here like any other: it is the project's operating manual, returned in full by get_project and applied before acting, so revise it as you learn how the project should be run.",
      inputSchema: {
        project: z.string(),
        heading: z.string(),
        content: z.string().describe("Markdown."),
        after: z
          .string()
          .describe('Place this section immediately after the named one. Pass "" to put it first. Omit to append, or to leave an existing section where it is.')
          .optional(),
      },
    },
    async ({ project, heading, content, after }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        // "" means first, which the tool schema spells that way because a JSON Schema optional cannot
        // distinguish "omitted" from "null" for a model, and those mean different things here.
        const placement = after === undefined ? undefined : after === "" ? null : after;
        const section = await setSection(db, { projectId: p.id, heading, content, after: placement }, ACTOR);
        await store.persist();
        // Echo the resulting order, not just the heading: placement is derived state, and a reply that changes
        // it should state it (MCP-21).
        const order = (await listSections(db, p.id)).map((s) => s.heading);
        return text(`set context section "${section.heading}"\norder: ${order.join(" -> ")}`);
      }),
  );

  server.registerTool(
    "delete_context",
    {
      annotations: WRITE,
      description: "Remove a context section by its exact heading (e.g. to retire an assumption or fold two sections into one).",
      inputSchema: { project: z.string(), heading: z.string() },
    },
    async ({ project, heading }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        // Same pre-check as a item ref: the domain's guard is correct but can only say the heading is unknown.
        if ((await getSection(db, p.id, heading)) === null) throw await noSuchSection(db, p, heading);
        const removed = await deleteSection(db, p.id, heading, ACTOR);
        await store.persist();
        return text(`removed context section "${removed.heading}"`);
      }),
  );

  server.registerTool(
    "add_comment",
    {
      annotations: WRITE,
      description:
        "Add a short remark to a item as work happens: something the user struggled with or asked, a detail worth having next time, a pointer to why something moved. " +
        "Write these freely as you work - little and often, not saved up - because a conversation is abandoned rather than closed, so anything held back for the end is lost. " +
        "One append, no reading first, so it is cheap enough to call mid-task. " +
        `Comments are capped at ${MAX_BODY} characters: if what you have to say is reasoning that belongs to the item itself, revise the item with edit_item instead, where a reader will find it. Use set_context for the project's settled narrative. ` +
        "`ref` is required: a comment is *about* something. Dated readings - a weight, macros, a duration - go to record_measurements, not here; prose about the project belongs in a context section (set_context) or the direction (set_direction). " +
        "Set `audience` to \"agent\" for your own working comments: those are kept out of user-facing summaries, but they are not private - the user can read them.",
      inputSchema: {
        project: z.string(),
        comment: z.string().describe(`A remark about the item, in a sentence or two. Markdown, up to ${MAX_BODY} characters.`),
        ref: z.string().describe("The item this comment is about, e.g. MCP-3. Required."),
        audience: z.enum(AUDIENCES).optional().describe('Defaults to "user".'),
      },
    },
    async ({ project, comment, ref, audience }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        // A bad ref fails the call rather than silently dropping the attachment: a comment filed against the
        // wrong thing is worse than one the model retries with the right ref. Filing against *nothing* is no
        // longer reachable at all - `ref` is required since `CTX-15`.
        const itemId = (await resolveRef(db, p, ref)).id;
        const saved = await addComment(db, { projectId: p.id, body: comment, itemId, audience }, ACTOR);
        await store.persist();
        return text(`commented${saved.itemId ? ` on ${ref}` : ""}`);
      }),
  );

  server.registerTool(
    "list_comments",
    {
      annotations: READ,
      description:
        "Read comments back, newest first. get_project does not return comments at all, so this and search_plan are how they are reached.",
      inputSchema: {
        project: z.string(),
        ref: z.string().optional().describe("Only comments about this item."),
        audience: z.enum(AUDIENCES).optional(),
        limit: z.number().int().positive().optional().describe("Defaults to 20."),
      },
      /**
       * A list of records, which is the case `MCP-26` settled a schema is right for - and the one place the
       * short id is *addressable* rather than merely printed. Without this, a program wanting to edit a
       * comment has to pull the id out of the text form, which is exactly the regex complaint the item was
       * filed about.
       *
       * `id` is the short form, matching what the text prints and what `edit_comment` takes: two id shapes in
       * one reply would be a trap, and the full uuid buys a caller nothing it can use.
       */
      outputSchema: {
        comments: z.array(
          z.object({
            id: z.string().describe(`Short id, as taken by edit_comment and delete_comment (its last ${SHORT_ID} characters).`),
            ref: z.string().nullable().describe("The item this comment is about, where there is one."),
            body: z.string(),
            audience: z.enum(AUDIENCES).describe('"agent" for Claude\'s own working comments.'),
            at: z.string().describe("When it was written, ISO-8601 UTC."),
          }),
        ),
      },
    },
    async ({ project, ref, audience, limit }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        // `undefined`, not `null`: no ref means "any comment", where null now means "only unattached ones".
        const itemId = ref === undefined ? undefined : (await resolveRef(db, p, ref)).id;
        const rows = await listComments(db, { projectId: p.id, itemId, audience, limit });
        if (rows.length === 0) return { ...text("(no comments yet)"), structuredContent: { comments: [] } };
        const refById = new Map((await listItems(db, { projectId: p.id })).map((i) => [i.id, i.ref]));
        const refOf = (c: Comment): string | null => (c.itemId === null ? null : (refById.get(c.itemId) ?? null));
        return {
          ...text(rows.map((c) => fmtComment(c, refOf(c) ?? undefined)).join("\n")),
          // Derived from the same rows as the text, in the same call, so the two cannot drift (MCP-26).
          structuredContent: {
            comments: rows.map((c) => ({
              id: shortCommentId(c.id),
              ref: refOf(c),
              body: c.body,
              audience: c.audience as (typeof AUDIENCES)[number],
              at: c.createdAt,
            })),
          },
        };
      }),
  );

  server.registerTool(
    "edit_comment",
    {
      annotations: WRITE,
      description:
        "Revise a comment you already wrote, when it turns out to be wrong or the approach has changed. Takes the short id shown beside each comment. " +
        "Prefer this to leaving a misleading comment in place: every session reads the recent ones back. The original text stays in the event log, so nothing is lost by correcting it.",
      inputSchema: {
        project: z.string(),
        id: z.string().describe(`The comment's short id, exactly as printed beside it (its last ${SHORT_ID} characters).`),
        comment: z.string().describe(`The replacement text, up to ${MAX_BODY} characters.`),
      },
    },
    async ({ project, id, comment }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        await editComment(db, p.id, id, comment, ACTOR);
        await store.persist();
        return text("comment updated");
      }),
  );

  server.registerTool(
    "delete_comment",
    {
      annotations: WRITE,
      description:
        "Remove a comment that is no longer worth carrying - a mistake, or something that has stopped mattering. Takes the short id shown beside each comment. " +
        "The removed comment stays in the event log, so this is a tidy-up rather than destroying history. Use edit_comment when the comment should be corrected rather than dropped.",
      inputSchema: {
        project: z.string(),
        id: z.string().describe(`The comment's short id, exactly as printed beside it (its last ${SHORT_ID} characters).`),
      },
    },
    async ({ project, id }): Promise<CallToolResult> =>
      guarded(async () => {
        const p = await resolveProject(db, caller, project);
        const removed = await deleteComment(db, p.id, id, ACTOR);
        await store.persist();
        return text(`deleted comment: ${removed.body}`);
      }),
  );

  server.registerTool(
    "open_viewer",
    {
      annotations: WRITE,
      // The description says "give the user the URL" because that is the whole point: the model cannot look at
      // the graph, so its only useful action is to hand the link over and let the human open it.
      description:
        "Return a URL that opens the roadmap graph on this project. " +
        "Give them the URL to click; it renders the projects they own, and the viewer's own selector switches " +
        "between them once it is open. Works both locally and through a hosted connector - on a hosted server " +
        "the link asks them to sign in first.",
      inputSchema: { project: z.string() },
    },
    async ({ project }): Promise<CallToolResult> =>
      guarded(async () => {
        // Resolved before binding: a bad key should fail here, naming the real ones, rather than hand back a
        // link that opens onto an error page (VIEW-4).
        const p = await resolveProject(db, caller, project);
        try {
          // The host builds the URL: the project rides in the hash (so it never reaches the server and cannot
          // collide with an asset path) and the write token in the query (so it does, since a fragment would
          // not). Stamped because this reply is the one that reads as proof of life - the URL looks identical
          // whether the process is current or an hour behind the build, and it was read as proof of both twice.
          return text(`Viewer running at ${await viewer.open(p.key)} - open it in a browser to see the graph.\n${buildStamp()}`);
        } catch (error) {
          // Caught here rather than left to `guarded`, so a failure to bind reads as one ("could not start the
          // viewer: no free port...") instead of as a bare port error with no subject.
          return errorText(`could not start the viewer: ${message(error)}`);
        }
      }),
  );
}
