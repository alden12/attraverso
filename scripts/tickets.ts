/**
 * The shared ticket model: the status vocabulary, the `RoadmapItem` shape, and `areasOf`. It has NO Node
 * dependencies, so the browser viewer (roadmap/) and the domain layer share one definition of a status and a
 * ticket ref. It began life as the marker-format parser, but the store is the source of truth now and the
 * markdown format is retired, so only the model remains.
 *
 * Status is a fixed vocabulary (below). Areas are open: the prefix of an id defines its area, and a new
 * prefix is picked up automatically - no central list to update.
 */

/** The fixed status vocabulary, in workflow order (shipped -> back-of-queue). `icon` is the glyph the
 *  viewer shows, `colour` is the hue it uses when colouring by status, and `strike` marks a status whose
 *  title is struck through (a closed/complete item). */
export const STATUSES = {
  done: { icon: "✓", label: "done", colour: "#34d399", strike: true }, // green - shipped on main
  review: { icon: "◐", label: "review", colour: "#a884f3", strike: false }, // purple - built, in a PR
  "in-progress": { icon: "●", label: "in-progress", colour: "#4f9dff", strike: false }, // blue - being built now
  "to-do": { icon: "○", label: "to-do", colour: "#fbbf24", strike: false }, // yellow - ready to build
  planning: { icon: "○", label: "planning", colour: "#e8590c", strike: false }, // deep orange - still being shaped
} as const;
export type Status = keyof typeof STATUSES;

/** The vocabulary as a non-empty tuple, which is the shape `z.enum` needs. Derived from `STATUSES` rather than
 *  written out, so a new status is one edit and every boundary that validates against it follows. */
export const STATUS_VALUES = Object.keys(STATUSES) as [Status, ...Status[]];

export interface RoadmapItem {
  id: string;
  area: string;
  status: Status;
  title: string;
  deps: string[];
  /** Parent ticket id for a nested (sub-)ticket, derived from a dotted id (`HOST-6.1` -> `HOST-6`); null for
   *  a top-level ticket. A ticket with children renders as a nested box in the viewer. */
  parent: string | null;
  /** Planned dates as `YYYY-MM-DD` (`CAL-1`), absent on an undated item, which is most of them. */
  start?: string;
  due?: string;
}

/**
 * A well-formed ref: an upper-case area prefix, then dot-separated positive integers (`MCP-3`, `MCP-3.1.2`).
 * Kept here rather than in the domain because the same shape governs `sortPath`, the viewer's nesting and the
 * store schema, and three copies of it would drift.
 */
export const REF_PATTERN = /^[A-Z][A-Z0-9]*-[1-9]\d*(\.[1-9]\d*)*$/;

export const isRef = (ref: string): boolean => REF_PATTERN.test(ref);

/**
 * A ref that names another project before the item: `apm:DIST-1` (`PROJ-11`).
 *
 * Split out rather than folded into `REF_PATTERN`, because the two are asked different questions: `isRef`
 * asks "is this a ref in this project", which a scoped one is not. The colon is unambiguous because an area
 * prefix is the text before the first `-` and a colon appears nowhere in a ref.
 *
 * **The tail must itself be a well-formed ref**, and a scope with a malformed tail returns null rather than
 * throwing: it then falls through to the ordinary local-ref path, which already refuses an unknown ref by
 * name. One refusal to read rather than two that disagree.
 */
export function splitScope(ref: string): { project: string; ref: string } | null {
  const cut = ref.indexOf(":");
  if (cut <= 0) return null;
  const bare = ref.slice(cut + 1);
  return isRef(bare) ? { project: ref.slice(0, cut), ref: bare } : null;
}

/** A ref with any project scope removed, which is the form every ref parser below expects. */
export const unscoped = (ref: string): string => splitScope(ref)?.ref ?? ref;

/** The area a ref belongs to: everything before the first `-`.
 *
 *  Scope-stripped first, or `apm:OPS-9` would report an area of `apm:OPS` and silently invent one. */
export const areaOf = (ref: string): string => {
  const bare = unscoped(ref);
  return bare.slice(0, bare.indexOf("-"));
};

/**
 * The parent of a nested ref (`MCP-3.1.2` -> `MCP-3.1`), or null for a top-level one. Nesting is *derived*
 * from the ref rather than stored independently, so this is the only definition of parentage there is.
 */
export function parentRef(ref: string): string | null {
  const cut = ref.lastIndexOf(".");
  return cut === -1 ? null : ref.slice(0, cut);
}

/**
 * Whether `ref` sits anywhere beneath `ancestor` in the nesting tree.
 *
 * The trailing dot is load-bearing: a bare `startsWith` would call `MCP-30` a child of `MCP-3`, which is the
 * kind of bug that only shows up once a project has thirty tickets in one area.
 */
export const isNestedUnder = (ancestor: string, ref: string): boolean => ref.startsWith(`${ancestor}.`);

/**
 * A calendar date, `2026-11-02`, as an item's `start` and `due` are written (`CAL-1`).
 *
 * The shape alone would pass `2026-02-30`, so the date is round-tripped through `Date` and has to come back
 * unchanged. Parsed as UTC on purpose: a bare date is a day, not an instant, and reading it in local time is
 * how a due date drifts by one for whoever is west of Greenwich. Here, so the viewer and the domain agree.
 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  // A month of 13 is an invalid Date, whose `toISOString` throws rather than answering.
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value);
}

/** The distinct areas present, in first-seen order (areas are open, so this is derived, not configured). */
export function areasOf(items: RoadmapItem[]): string[] {
  const seen: string[] = [];
  for (const item of items) if (!seen.includes(item.area)) seen.push(item.area);
  return seen;
}
