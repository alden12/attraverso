/**
 * The viewer's data source (VIEW-11): the store fetched over HTTP at runtime, mapped into the shape the graph
 * already speaks (`RoadmapItem`).
 *
 * It used to be a build-time `?raw` import of `../roadmap.apm.yaml`, which pinned the viewer to *this* repo's
 * plan: a production build was a frozen snapshot, and a Claude Desktop user whose store lives in their home dir
 * would have been shown someone else's project. Fetching means one built viewer renders whatever store is
 * served to it - by the Vite dev server here, and by the MCP server itself at VIEW-12, which is the only
 * process that knows which store is actually loaded.
 *
 * The endpoint hands back the whole store rather than a pre-mapped graph: mapping to `RoadmapItem` is the
 * viewer's business, and serving every project is what the switcher (VIEW-4) needs. The file is validated
 * when it is written (importStore/saveStore enforce the schema and the dep/parent FKs), so the viewer trusts
 * it and only maps, never re-validates.
 */
import type { RoadmapItem, Status } from "../scripts/tickets";
import { authHeaders } from "./session";

/** Same-origin, so it works unchanged under the dev server and under whatever the MCP server binds to. */
export const STORE_ENDPOINT = "/api/store";

/**
 * The write token, handed to this page in the query string by `open_viewer` (VIEW-17).
 *
 * Absent under `yarn viewer`, and that is the design rather than an oversight: the dev server is a second
 * process on the same file, so letting it write would be the two-writer failure that lost a ticket on
 * 2026-07-30 (`IMP-13`). No token, no upload control, read-only - which is what the dev server is for.
 */
export const writeToken = (): string | null => new URLSearchParams(window.location.search).get("t");

/**
 * Whether this viewer may write at all, which the UI asks before offering a control rather than before
 * failing one.
 *
 * True under the loopback host (a write token in the URL) and under the hosted server (a signed-in session),
 * false under the dev server, which is deliberately read-only. Same rule as `writeHeaders` below, phrased as a
 * question - the two must agree or the page offers a button that throws.
 */
export const canWrite = (): boolean => writeToken() !== null || Object.keys(authHeaders()).length > 0;

/**
 * The headers that prove a write is allowed, or a message saying why none can be produced.
 *
 * Two credentials, because there are two hosts and they know different things. The loopback host has no idea
 * who is calling - it is a port on a machine - so it issues a write token and checks it. The hosted server has
 * a verified account, so the session is the credential and there is no token at all (`VIEW-24`).
 *
 * Either is sufficient. Neither means read-only, which is the dev server: a second process on the same file,
 * where writing would be the two-writer failure that lost a ticket on 2026-07-30 (`IMP-13`).
 */
export function writeHeaders(action: string): Record<string, string> {
  const token = writeToken();
  const session = authHeaders();
  if (token !== null) return { "x-apm-token": token, ...session };
  if (Object.keys(session).length > 0) return session;
  throw new Error(`this viewer is read-only - open it with the open_viewer tool to ${action}`);
}

/**
 * Move a ticket to another status (VIEW-17).
 *
 * Nothing is returned: the caller refetches the plan and renders from that, because the panel showing this
 * status is not the only thing affected - the node on the graph changes colour and may gain a strike-through.
 * A local update would have to duplicate all of that and would still be a copy that drifts.
 */
export async function setTicketStatus(projectKey: string, ref: string, status: Status): Promise<void> {
  const response = await fetch(`/api/ticket?project=${encodeURIComponent(projectKey)}&ref=${encodeURIComponent(ref)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...writeHeaders("change a status") },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? `could not change the status (${response.status})`);
}

/** Remove an attachment from its ticket. The blob stays on disk - another ticket may reference the same bytes
 *  - so this is "take it off this ticket", not "destroy it". */
export async function deleteAttachment(projectKey: string, hash: string): Promise<void> {
  const response = await fetch(`/api/media/${hash}?project=${encodeURIComponent(projectKey)}`, {
    method: "DELETE",
    headers: writeHeaders("remove an image"),
  });
  if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? `remove failed (${response.status})`);
}

/** Post an image to the ticket it was dropped on. Returns the stored reference, or throws with the server's
 *  own message, which is already phrased for a person ("image is 18.2MB, over the 12MB limit"). */
export async function uploadAttachment(projectKey: string, ref: string, file: File): Promise<Attachment> {
  const response = await fetch(`/api/media?project=${encodeURIComponent(projectKey)}&ref=${encodeURIComponent(ref)}`, {
    method: "POST",
    headers: { "content-type": file.type, ...writeHeaders("upload") },
    body: file,
  });
  const payload = (await response.json()) as { hash?: string; mime?: string; bytes?: number; error?: string };
  if (!response.ok) throw new Error(payload.error ?? `upload failed (${response.status})`);
  return { hash: payload.hash!, mime: payload.mime!, bytes: payload.bytes!, at: new Date().toISOString() };
}

interface StoreItem {
  ref: string;
  area: string;
  title: string;
  status: string;
  deps?: string[];
  parent?: string;
  start?: string;
  due?: string;
  closed_at?: string;
  body?: string;
  attachments?: Attachment[];
}

/** An image on a ticket (MEDIA-1). Only the reference travels; the bytes are fetched from `/media/<hash>`
 *  when the browser gets round to rendering the tag, so a project full of photos costs nothing to load. */
export interface Attachment {
  hash: string;
  mime: string;
  bytes: number;
  caption?: string;
  at: string;
}
interface StoreProject {
  key: string;
  name: string;
  /** The agreed work order as refs (`PROJ-8`). Already filtered to open items by `asPlan`, so the viewer
   *  renders what it is handed rather than re-deriving the rule. */
  next?: string[];
  items: StoreItem[];
}
/** The path rides along with the store so the viewer can say *which* file it is showing - the question a
 *  Desktop user actually has, given the store could be in a repo or in their home dir. */
/**
 * One metric's summary for the detail pane (`METRIC-4`, MVP slice). Deliberately not a series: the feed
 * carries one row per (item, metric) however long the series gets, and raw points stay behind a windowed
 * request that only a chart would make.
 */
export interface MetricSummary {
  /** The subject item's ref, or null for a reading about the project itself. */
  ref: string | null;
  metric: string;
  count: number;
  latest: number | null;
  latestText: string | null;
  latestAt: string;
  firstAt: string;
  /** More than one means the readings are not directly comparable. */
  units: string[];
  /** For a categorical metric, its commonest values. Capped, with `distinctValues` carrying the real total. */
  values: { text: string; count: number }[];
  distinctValues: number;
}

interface StoreResponse {
  /** Null when a database is the source of truth and there is no plan file at all (OPS-11). */
  path: string | null;
  store: { projects: StoreProject[] };
  /** Metric summaries per project key. Beside `store`, never inside it: `store` is the YAML shape and
   *  measurements are deliberately not in the plan file. */
  metrics?: Record<string, MetricSummary[]>;
  /** Why uploads are refused, or null when they work. */
  uploadsDisabled?: string | null;
}

/** One project, ready to render. */
export interface ProjectPlan {
  key: string;
  name: string;
  items: RoadmapItem[];
  /** The agreed order, most important first. Empty when nobody has recorded one. */
  next: string[];
  bodies: Map<string, string>;
  attachments: Map<string, Attachment[]>;
  /** Metric summaries by item ref. Project-level readings are under the empty key, which nothing renders
   *  yet - the detail pane is per-item, and a home for those is the standalone view METRIC-4 is unsure about. */
  metrics: Map<string, MetricSummary[]>;
}

/** Every project in the served store. The viewer holds them all and switches between them client-side, because
 *  they all belong to the same person: one viewer left open, not one per project. */
export interface Plan {
  /** Null in cloud mode, where the database is the source of truth and there is no file to name. */
  storePath: string | null;
  projects: ProjectPlan[];
  /** Why uploads are refused, or null when they work. The viewer hides its drop zone rather than offering a
   *  control the server will answer 501 to. */
  uploadsDisabled: string | null;
}

/** Group by a derived key, preserving order within each group. */
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) out.set(key(row), [...(out.get(key(row)) ?? []), row]);
  return out;
}

export async function fetchPlan(): Promise<Plan> {
  const response = await fetch(STORE_ENDPOINT, { headers: authHeaders() });
  if (!response.ok) throw new Error(`${STORE_ENDPOINT} returned ${response.status} ${response.statusText}`);
  const { path, store, metrics, uploadsDisabled } = (await response.json()) as StoreResponse;

  return {
    storePath: path,
    uploadsDisabled: uploadsDisabled ?? null,
    // An empty store is a legitimate first run, not an error: it renders as the empty state, not a failure.
    projects: (store.projects ?? []).map((project) => ({
      key: project.key,
      name: project.name,
      // Items already arrive ordered by (area, sort_path) from the deterministic export, which is the order the
      // graph lays them out in.
      items: project.items.map((item) => ({
        id: item.ref,
        area: item.area,
        status: item.status as Status,
        title: item.title,
        deps: item.deps ?? [],
        parent: item.parent ?? null,
        start: item.start,
        due: item.due,
        closed: item.closed_at,
      })),
      // Refs that name no rendered item are dropped: the served store is a projection, and a panel row that
      // selects nothing would be a dead link rather than a jump.
      next: (project.next ?? []).filter((ref) => project.items.some((item) => item.ref === ref)),
      // A ticket's prose for the detail pane, read straight from its stored `body`.
      bodies: new Map(project.items.map((item) => [item.ref, item.body ?? ""])),
      attachments: new Map(project.items.filter((item) => item.attachments?.length).map((item) => [item.ref, item.attachments!])),
      metrics: groupBy(metrics?.[project.key] ?? [], (m) => m.ref ?? ""),
    })),
  };
}

/**
 * What the URL hash asks for: a project (`#spanish`), and optionally an item in it (`#spanish/GRAM-3`).
 *
 * The item half arrived with the calendar (`CAL-3`), which shows several projects at once: clicking another
 * project's item has to switch project *and* open that item, and the switch remounts the viewer, so the item
 * has to survive it - the URL is the one thing that does. It is also a link to an item, which `VIEW-4`
 * anticipated. A ref never contains a `/`, so the first one is the split.
 */
export function parseHash(hash: string): { project: string | null; item: string | null } {
  const raw = decodeURIComponent(hash.replace(/^#/, ""));
  const cut = raw.indexOf("/");
  const project = (cut === -1 ? raw : raw.slice(0, cut)) || null;
  const item = cut === -1 ? null : raw.slice(cut + 1) || null;
  return { project, item };
}

/** What the viewer should render, given the store and the project asked for in the URL hash. */
export interface Selection {
  /** The project to render, or null when there is nothing unambiguous to show. */
  project: ProjectPlan | null;
  /** Why there is no project, phrased for the user. Null when one is selected. */
  notice: string | null;
}

/**
 * Resolve `#spanish` (or the absence of it) against the served store.
 *
 * The rule this replaces was `store.projects[0]`, which rendered whichever project sorted first by key and
 * gave no sign the others existed. Every case below is that same bug avoided: **never choose silently among
 * alternatives**. Picking the only project is not a choice, so that one case does render without asking.
 */
export function selectProject(projects: ProjectPlan[], requested: string | null): Selection {
  if (projects.length === 0) {
    return { project: null, notice: "This store has no projects yet. Create one and it will appear here." };
  }
  if (requested !== null) {
    const match = projects.find((project) => project.key === requested);
    if (match) return { project: match, notice: null };
    // Named explicitly rather than quietly falling back: a stale bookmark that renders the wrong project
    // silently is worse than one that says so.
    return {
      project: null,
      notice: `No project "${requested}" in this store. It holds: ${projects.map((project) => project.key).join(", ")}.`,
    };
  }
  if (projects.length === 1) return { project: projects[0]!, notice: null };
  return { project: null, notice: "This store holds several projects. Choose one to see its graph." };
}
