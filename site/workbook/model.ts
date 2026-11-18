/**
 * The plan as a workbook, and a workbook's edits back as operations (`DIST-9.2`): how an assistant that can only
 * edit a spreadsheet - Microsoft 365 Copilot in Excel, on a machine with nothing installed - edits a plan.
 *
 * **Only the Pages site has it** (`DIST-10`): it lives under `site/`, which the published package and the cloud
 * server never import (`site/boundary.test.ts` holds that), because a spreadsheet round trip is for a machine with
 * nothing installed, and anywhere the server runs, the MCP tools do this better.
 *
 * **Pure, and Node-free**, like the shared ticket model: no file, no spreadsheet library and no database here, so
 * the same code runs in the browser tab that will do this for real (`DIST-9.1`) and in a test. `xlsx.ts` turns the
 * layout into a file and a file into a `Grid`; `apply.ts` sends the operations through the library.
 *
 * **Three versions, not two.** A refresh compares the workbook with the **snapshot** taken at export, which is how it
 * sees what changed rather than a whole new file, and then with the plan as it is **now**: a cell is applied only
 * where the plan still holds what was exported, so an edit made elsewhere since (the viewer, an agent) is never
 * silently overwritten by an older copy in the workbook. Where both changed, it is flagged and the plan's kept.
 *
 * **Fix what is safe, flag what is a judgement, refuse what is wrong**, row by row, so a bad row costs a round trip
 * and never a broken plan: an assistant cannot be right every time, so the bar is that a miss is harmless.
 */
import { STATUS_VALUES } from "../../scripts/tickets";
import { parsePointers } from "../../scripts/references";
import type { Store } from "../../src/serialise/plan";

/** One item as the workbook shows it: every field a cell, as text. */
export interface SnapshotItem {
  /** The plan's own id, in the hidden column: what keeps a row tied to its item whatever is done to the ref. */
  id: string;
  ref: string;
  title: string;
  status: string;
  parent: string;
  /** Comma-separated refs, in the plan's order. */
  deps: string;
  start: string;
  due: string;
  body: string;
}

/** What one project looked like when exported: what a refresh diffs against. Kept beside the workbook, not in it,
 *  so nothing in the workbook can edit what it is measured against. */
export interface WorkbookSnapshot {
  version: 1;
  project: string;
  exportedAt: string;
  items: SnapshotItem[];
  next: string[];
}

/** One project of a plan, as a snapshot. Soft-deleted items are not part of it. */
export function snapshotOf(store: Store, key: string, now: string = new Date().toISOString()): WorkbookSnapshot {
  const project = store.projects.find((p) => p.key === key);
  if (project === undefined) throw new Error(`no project "${key}" in this plan`);
  const live = project.items.filter((i) => i.deleted_at === undefined);
  const refs = new Set(live.map((i) => i.ref));
  return {
    version: 1,
    project: key,
    exportedAt: now,
    items: live.map((i) => ({
      id: i.id,
      ref: i.ref,
      title: i.title,
      status: i.status,
      parent: i.parent ?? "",
      deps: (i.deps ?? []).join(", "),
      start: i.start ?? "",
      due: i.due ?? "",
      body: i.body ?? "",
    })),
    next: (project.next ?? []).filter((ref) => refs.has(ref)),
  };
}

/** Excel's cell limit is 32,767 characters; a body past this is exported cut, and its cell refuses edits. */
export const CELL_LIMIT = 32_000;
const CUT_MARK = "\n\n[cut short here: too long for a cell, so edit it in the viewer]";
/** A body as its cell holds it. */
export const cellBody = (body: string): string => (body.length > CELL_LIMIT ? body.slice(0, CELL_LIMIT) + CUT_MARK : body);

export const ITEM_COLUMNS = ["Ref", "Title", "Status", "Parent", "Depends on", "Start", "Due", "Body", "id"] as const;
export const NEXT_COLUMNS = ["Rank", "Ref", "Title"] as const;
export const SHEETS = { readme: "Read me", items: "Items", next: "Next" } as const;

/**
 * The Read me sheet: what an assistant is told before it edits. Written for a model as much as a person, so each
 * rule says what to do rather than only what not to, and the one easy mistake on each sheet (editing the id, moving
 * a Next row without changing its rank) is named. The stand-in test (2026-11-18) is why the new item's default
 * status is stated: without it, one model guessed `planning`.
 */
export function readmeLines(project: string): string[] {
  return [
    `How to edit this plan (${project})`,
    "",
    "This workbook is a copy of a project plan. A tool reads your changes back into the plan, checks each one, and reports what it did.",
    "",
    "Items sheet: one row per item.",
    `- To change an item's status, set its Status cell to one of: ${STATUS_VALUES.join(", ")}.`,
    "- To rename or reword an item, edit its Title or Body cell.",
    "- To add an item, add a new row at the bottom of the table with Ref left EMPTY, and Parent set to the item it belongs under. The tool gives it a ref. Its Status is to-do unless the user says otherwise.",
    "- An item at the top of a group has no parent item: set Parent to the group's prefix instead (the letters before the dash, e.g. DATA). A prefix no item has yet starts a new group.",
    "- Depends on: refs separated by commas (e.g. DATA-1, VIEW-2).",
    "- Start and Due: dates as YYYY-MM-DD, or empty.",
    "- Never edit, fill in or copy the id column. Never change an existing Ref or Parent.",
    "- Keep any [ref key] markers in a Body where they are: each one marks where a claim's source is recorded.",
    "- Do not delete rows. To have an item deleted, tell the user instead.",
    "",
    "Next sheet: the ordered list of what to do next, most important first.",
    "- The Rank column is what counts: to reorder, change the Rank numbers (1 is first). Moving rows without changing Rank does nothing.",
    "- To add an item to the list, add a row with its Ref and a Rank. To remove one, clear its Rank.",
    "- Title is shown for reference only; editing it does nothing.",
  ];
}

/** A workbook as read back: each sheet's header row and its non-empty rows, every cell as text. */
export interface Grid {
  sheets: GridSheet[];
}
export interface GridSheet {
  name: string;
  headers: string[];
  /** 1-based spreadsheet row numbers, so a report can say where to look. */
  rows: { row: number; cells: string[] }[];
  hiddenColumns: string[];
}

/** An operation a refresh found, for `apply.ts`. `at` says which row it came from. */
export type WorkbookOperation =
  | { kind: "create"; at: string; under: { parent: string } | { area: string }; title: string; status: string; deps: string[]; start?: string; due?: string; body: string }
  | { kind: "edit"; at: string; ref: string; changes: { title?: string; body?: string; deps?: string[]; start?: string | null; due?: string | null } }
  | { kind: "status"; at: string; ref: string; status: string }
  | { kind: "next"; at: string; refs: string[] };

/** A line of the report a refresh gives the user, beside the operations. */
export interface ReportLine {
  kind: "fixed" | "flagged" | "refused" | "conflict" | "note";
  at: string;
  message: string;
}

export interface RefreshPlan {
  operations: WorkbookOperation[];
  report: ReportLine[];
}

const STATUSES: readonly string[] = STATUS_VALUES;
/** A scoped ref keeps its project key in lower case (`apm:DIST-1`); the ref itself is upper case. */
const normRef = (ref: string): string => {
  const at = ref.indexOf(":");
  return at === -1 ? ref.toUpperCase() : `${ref.slice(0, at).toLowerCase()}:${ref.slice(at + 1).toUpperCase()}`;
};
const splitRefs = (text: string): string[] => text.split(/[,;\s]+/).filter(Boolean).map(normRef);
/** Deps compared as a set: their order in a cell carries nothing. */
const sameDeps = (a: string, b: string): boolean => [...splitRefs(a)].sort().join() === [...splitRefs(b)].sort().join();
const keys = (body: string): string[] => parsePointers(body).pointers.map((p) => p.key);

/**
 * What a workbook's edits would do to the plan: the operations to apply and the report to show, without applying
 * anything. `base` is the snapshot taken at export, `current` the plan now (`snapshotOf` again).
 */
export function planRefresh(base: WorkbookSnapshot, grid: Grid, current: WorkbookSnapshot): RefreshPlan {
  const operations: WorkbookOperation[] = [];
  const report: ReportLine[] = [];
  const say = (kind: ReportLine["kind"], at: string, message: string) => report.push({ kind, at, message });

  const sheet = (name: string) => grid.sheets.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
  for (const s of grid.sheets) {
    if (!Object.values(SHEETS).some((name) => name.toLowerCase() === s.name.trim().toLowerCase())) say("note", s.name, `sheet "${s.name}" is not one of ours, so it is left as it is`);
  }

  const baseById = new Map(base.items.map((i) => [i.id, i]));
  const nowById = new Map(current.items.map((i) => [i.id, i]));
  const nowByRef = new Map(current.items.map((i) => [i.ref, i]));

  // ---- Items
  const items = sheet(SHEETS.items);
  const seen = new Map<string, string>();
  /** New groups already announced, so three rows starting one group say so once. */
  const startedGroups = new Set<string>();
  if (items === undefined) say("flagged", SHEETS.items, "the Items sheet is missing, so no item edits were read");
  else {
    const col = columnsOf(items, ITEM_COLUMNS, say);
    if (!items.hiddenColumns.map((h) => h.toLowerCase()).includes("id")) say("note", SHEETS.items, "the id column is no longer hidden");
    for (const { row, cells } of items.rows) {
      const at = `${SHEETS.items} row ${row}`;
      const cell = (name: (typeof ITEM_COLUMNS)[number]) => (col[name] === undefined ? "" : (cells[col[name]!] ?? ""));
      const id = cell("id").trim();
      const ref = normRef(cell("Ref").trim());
      if (id !== "" && seen.has(id)) {
        say("flagged", at, `same id as ${seen.get(id)}, so probably a copied row: not applied`);
        continue;
      }
      let was = id === "" ? undefined : baseById.get(id);
      if (id !== "" && was === undefined) {
        say("flagged", at, `its id is not one this workbook was exported with: not applied`);
        continue;
      }
      if (was === undefined && ref !== "") {
        // No id. An existing item whose id cell was cleared is matched by its ref; anything else is new.
        was = base.items.find((i) => i.ref === ref);
        if (was !== undefined) {
          if (seen.has(was.id)) {
            say("flagged", at, `${ref} appears twice: not applied`);
            continue;
          }
          say("fixed", at, `${ref} had lost its id, so it was matched by its ref`);
        }
      }
      if (was === undefined) {
        createFrom(at, ref, cell);
        continue;
      }
      seen.set(was.id, at);
      editFrom(at, was, cell);
    }
    for (const i of base.items) {
      if (!seen.has(i.id) && nowById.has(i.id)) say("flagged", `${SHEETS.items}`, `${i.ref} is missing from the sheet. Deleted? Not applied: a deletion is asked for, never inferred`);
    }
  }

  function status(text: string, at: string): string | null {
    const s = text.trim().toLowerCase().replace(/\s+/g, "-");
    if (!STATUSES.includes(s)) {
      say("refused", at, `status "${text}" is not one of ${STATUSES.join(", ")}`);
      return null;
    }
    if (s !== text) say("fixed", at, `status "${text}" read as ${s}`);
    return s;
  }

  function day(text: string, at: string, field: string): string | null | undefined {
    const d = text.trim();
    if (d === "") return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))) return d;
    say("refused", at, `${field} "${text}" is not a day as YYYY-MM-DD`);
    return undefined;
  }

  function deps(text: string, at: string, known: (ref: string) => boolean): string[] {
    const refs = splitRefs(text);
    // Said only when the reading changed something: a ref's case, or a separator other than a comma.
    const written = text.split(/[,;\s]+/).filter(Boolean);
    if (written.join() !== refs.join() || /;/.test(text)) say("fixed", at, `depends on "${text}" read as "${refs.join(", ")}"`);
    for (const r of refs) if (!r.includes(":") && !known(r)) say("flagged", at, `depends on ${r}, which is not an item in this plan`);
    return refs;
  }

  function createFrom(at: string, ref: string, cell: (name: (typeof ITEM_COLUMNS)[number]) => string) {
    const title = cell("Title").trim();
    if (title === "") {
      say("refused", at, "a new row with no title");
      return;
    }
    if (ref !== "") say("flagged", at, `a new item "${title}" with a ref of its own, ${ref}: refs are given by the plan, so it gets the next free one`);
    const parent = normRef(cell("Parent").trim());
    if (parent === "") {
      say("refused", at, `new item "${title}" has no Parent, so there is nowhere to file it`);
      return;
    }
    // An area prefix rather than an item: a top-level item in that group, and a prefix nothing has yet starts one.
    // Areas are open (the prefix *is* the area), so a new one needs no declaring first.
    const isArea = /^[A-Z][A-Z0-9]*$/.test(parent);
    if (!isArea && !nowByRef.has(parent)) {
      say("refused", at, `new item "${title}" is under ${parent}, which is not an item in this plan`);
      return;
    }
    if (isArea && !current.items.some((i) => i.ref.startsWith(`${parent}-`)) && !startedGroups.has(parent)) {
      startedGroups.add(parent);
      say("note", at, `"${title}" starts a new group, ${parent}`);
    }
    const s = cell("Status").trim() === "" ? "to-do" : status(cell("Status"), at);
    const start = day(cell("Start"), at, "start");
    const due = day(cell("Due"), at, "due");
    if (s === null || start === undefined || due === undefined) return;
    operations.push({
      kind: "create",
      at,
      under: isArea ? { area: parent } : { parent },
      title,
      status: s,
      deps: cell("Depends on").trim() === "" ? [] : deps(cell("Depends on"), at, (r) => nowByRef.has(r)),
      ...(start === null ? {} : { start }),
      ...(due === null ? {} : { due }),
      body: cell("Body").replace(/\r\n/g, "\n"),
    });
  }

  function editFrom(at: string, was: SnapshotItem, cell: (name: (typeof ITEM_COLUMNS)[number]) => string) {
    const now = nowById.get(was.id);
    const theirs = {
      ref: normRef(cell("Ref").trim()),
      title: cell("Title").trim(),
      status: cell("Status"),
      parent: normRef(cell("Parent").trim()),
      deps: cell("Depends on").trim(),
      start: cell("Start").trim(),
      due: cell("Due").trim(),
      body: cell("Body").replace(/\r\n/g, "\n"),
    };
    if (theirs.ref !== was.ref) say("flagged", at, `${was.ref}'s ref was changed to "${theirs.ref}": renaming is not done from the workbook, so not applied`);
    if (theirs.parent !== was.parent) say("flagged", at, `${was.ref}'s parent was changed to "${theirs.parent}": moving an item is a rename, so not applied`);
    const changed = {
      title: theirs.title !== was.title,
      status: theirs.status !== was.status,
      deps: !sameDeps(theirs.deps, was.deps),
      start: theirs.start !== was.start,
      due: theirs.due !== was.due,
      body: theirs.body !== cellBody(was.body),
    };
    if (!Object.values(changed).some(Boolean)) return;
    if (now === undefined) {
      say("conflict", at, `${was.ref} was edited in the workbook but has been deleted from the plan since: not applied`);
      return;
    }
    const ref = now.ref;
    /** Three-way: apply when the plan still holds what was exported; when it moved too, keep the plan's and say so. */
    const settled = (field: string, ours: string, base: string, same: (a: string, b: string) => boolean = (a, b) => a === b): boolean => {
      if (same(ours, base)) return true;
      say("conflict", at, `${ref}'s ${field} was changed in the plan since the export too, so the plan's was kept`);
      return false;
    };
    const edit: Extract<WorkbookOperation, { kind: "edit" }>["changes"] = {};
    if (changed.title && settled("title", now.title, was.title)) {
      if (theirs.title === "") say("refused", at, `${ref}'s title was cleared`);
      else edit.title = theirs.title;
    }
    if (changed.body && settled("body", now.body, was.body)) {
      if (was.body.length > CELL_LIMIT) say("refused", at, `${ref}'s body is too long for a cell, so it was exported cut short and cannot be edited here`);
      else {
        const lost = keys(was.body).filter((k) => !keys(theirs.body).includes(k));
        if (lost.length > 0) say("flagged", at, `${ref}'s new body drops ${lost.map((k) => `[ref ${k}]`).join(", ")}, which retires the sources behind ${lost.length === 1 ? "that claim" : "those claims"}`);
        edit.body = theirs.body;
      }
    }
    if (changed.deps && settled("dependencies", now.deps, was.deps, sameDeps)) edit.deps = deps(theirs.deps, at, (r) => nowByRef.has(r));
    for (const field of ["start", "due"] as const) {
      if (changed[field] && settled(field, now[field], was[field])) {
        const d = day(theirs[field], at, field);
        if (d !== undefined) edit[field] = d;
      }
    }
    if (Object.keys(edit).length > 0) operations.push({ kind: "edit", at, ref, changes: edit });
    if (changed.status && settled("status", now.status, was.status)) {
      const s = status(theirs.status, at);
      if (s !== null && s !== was.status) operations.push({ kind: "status", at, ref, status: s });
    }
  }

  // ---- Next
  const next = sheet(SHEETS.next);
  if (next === undefined) say("flagged", SHEETS.next, "the Next sheet is missing, so the order was not read");
  else {
    const col = columnsOf(next, NEXT_COLUMNS, say);
    const ranked: { ref: string; rank: number; row: number }[] = [];
    for (const { row, cells } of next.rows) {
      const at = `${SHEETS.next} row ${row}`;
      const rank = (col.Rank === undefined ? "" : (cells[col.Rank] ?? "")).trim();
      const ref = normRef((col.Ref === undefined ? "" : (cells[col.Ref] ?? "")).trim());
      if (rank === "") continue; // cleared: off the list
      if (!/^\d+(\.\d+)?$/.test(rank)) {
        say("refused", at, `rank "${rank}" is not a number`);
        continue;
      }
      if (!nowByRef.has(ref)) {
        say("refused", at, `${ref || "a row with no ref"} is not an item in this plan`);
        continue;
      }
      ranked.push({ ref, rank: Number(rank), row });
    }
    if (new Set(ranked.map((r) => r.rank)).size !== ranked.length) say("flagged", SHEETS.next, "two rows share a rank, so the higher row went first");
    const order = [...ranked].sort((a, b) => a.rank - b.rank || a.row - b.row).map((r) => r.ref);
    const unique = [...new Set(order)];
    if (unique.length !== order.length) say("fixed", SHEETS.next, "an item listed twice was kept at its first place");
    const byRow = [...ranked].sort((a, b) => a.row - b.row).map((r) => r.ref);
    if (unique.join() !== base.next.join()) {
      if (current.next.join() !== base.next.join()) say("conflict", SHEETS.next, "the Next list was changed in the plan since the export too, so the plan's was kept");
      else operations.push({ kind: "next", at: SHEETS.next, refs: unique });
    } else if (byRow.join() !== base.next.join()) say("note", SHEETS.next, "rows were moved but no rank changed, so the order is unchanged: the Rank column is what counts");
  }

  return { operations, report };
}

/** Where each expected column is, by header, so a moved column still reads; missing ones are flagged. */
function columnsOf<C extends string>(sheet: GridSheet, expected: readonly C[], say: (kind: ReportLine["kind"], at: string, message: string) => void): Partial<Record<C, number>> {
  const out: Partial<Record<C, number>> = {};
  const headers = sheet.headers.map((h) => h.trim().toLowerCase());
  for (const name of expected) {
    const at = headers.indexOf(name.toLowerCase());
    if (at === -1) say("flagged", sheet.name, `the ${name} column is missing`);
    else out[name] = at;
  }
  for (const h of sheet.headers) if (h.trim() !== "" && !expected.some((e) => e.toLowerCase() === h.trim().toLowerCase())) say("note", sheet.name, `column "${h}" is not one of ours, so it is left as it is`);
  return out;
}
