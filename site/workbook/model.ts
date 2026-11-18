/**
 * A spreadsheet as the plan (`DIST-9.2`): for an assistant that can only edit a spreadsheet - Microsoft 365 Copilot
 * in Excel, on a machine where nothing can be installed and no MCP server reached. **The workbook is the source of
 * truth**, and the xlsx bridge page (`DIST-9.1`) is a read-only mirror of it: it reads the file, builds the plan in
 * memory and shows it in the viewer. Nothing is ever written back, so there is no second copy to reconcile.
 *
 * It replaced a round trip (export a plan to a workbook, diff the edits against a snapshot, apply them through the
 * library from the command line), which needed Node on the very machine this is for. That code is at `81ba095`
 * (the merge of #146) should a round trip be wanted again, for instance to bring a workbook plan into a real one.
 *
 * **Only the Pages site has it** (`DIST-10`): it lives under `site/`, which the published package and the cloud
 * server never import (`site/boundary.test.ts` holds that).
 *
 * **Pure, and Node-free**: no file, no spreadsheet library and no database here. `xlsx.ts` turns a file into a
 * `Grid` and rows into a file.
 *
 * **Show what can be shown, and say what is wrong.** The page cannot fix the file, so a bad row is never a reason
 * to show nothing: a mistyped status shows as `to-do`, an unknown dependency is dropped, and each is listed as a
 * problem against its row for the user (or their assistant) to fix in the workbook. Only a row with no usable ref
 * is left out, since the ref is what everything else points at.
 */
import { isCalendarDate, isRef, parentRef, STATUS_VALUES } from "../../scripts/tickets";
import { sortPath } from "../../src/db/ids";
import type { Store } from "../../src/serialise/plan";

export const ITEM_COLUMNS = ["Ref", "Title", "Status", "Depends on", "Start", "Due", "Body"] as const;
export const NEXT_COLUMNS = ["Rank", "Ref", "Title"] as const;
export const SHEETS = { readme: "Read me", items: "Items", next: "Next" } as const;

/**
 * The Read me sheet: the only instructions an assistant in Excel gets, since there is no server to give it a
 * protocol. Written for a model as much as a person, so each rule says what to do, and the easy mistakes (a new
 * row with no ref, moving a Next row without changing its rank) are named.
 */
export function readmeLines(): string[] {
  return [
    "How to edit this plan",
    "",
    "This workbook is a project plan. A web page shows it as a graph and lists any problems it finds in it.",
    "",
    "Items sheet: one row per item (a task, a goal, anything to work on).",
    "- Ref is the item's id: a group prefix in capitals, a dash and a number, e.g. DATA-1. Refs must be unique.",
    "- To add an item, add a row with the next free number in its group (after DATA-3 comes DATA-4). A new prefix starts a new group.",
    "- To put an item under another, extend that item's ref with a dot: DATA-3.1 and DATA-3.2 sit under DATA-3.",
    `- Status is one of: ${STATUS_VALUES.join(", ")}. Leave it empty for to-do.`,
    "- Depends on: the refs this item needs done first, separated by commas (e.g. DATA-1, VIEW-2).",
    "- Start and Due: dates as YYYY-MM-DD, or empty.",
    "- Body: any longer description.",
    "- Never change an existing Ref: other rows point at it. Do not delete rows unless the user asks.",
    "",
    "Next sheet: the ordered list of what to do next, most important first.",
    "- The Rank column is what counts (1 is first): to reorder, change the Rank numbers. Moving rows without changing Rank does nothing.",
    "- To add an item to the list, add a row with its Ref and a Rank. To take one off, clear its Rank.",
    "- Title is shown for reference only.",
  ];
}

/** A workbook as read back: each sheet's header row and its non-empty rows, every cell as text. */
export interface Grid {
  sheets: GridSheet[];
}
export interface GridSheet {
  name: string;
  headers: string[];
  /** 1-based spreadsheet row numbers, so a problem can say where to look. */
  rows: { row: number; cells: string[] }[];
}

/** Something wrong with the workbook, and where. */
export interface Problem {
  at: string;
  message: string;
}

/** One item's row, as the writer takes it. */
export interface ItemRow {
  ref: string;
  title: string;
  status: string;
  deps: string[];
  start?: string;
  due?: string;
  body?: string;
}

export interface Read {
  store: Store;
  problems: Problem[];
}

const STATUSES: readonly string[] = STATUS_VALUES;
const splitRefs = (text: string): string[] =>
  text
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((r) => r.toUpperCase());

/**
 * The plan a workbook holds, as a one-project store, and what is wrong with it. `name` is the project's name (the
 * file's), `at` the time every row is stamped with (the file's last change), and `idOf` gives each ref the same id
 * on every read, so a reload is the same items rather than new ones.
 */
export function readPlan(grid: Grid, name: string, at: string, idOf: (key: string) => string): Read {
  const problems: Problem[] = [];
  const say = (where: string, message: string) => problems.push({ at: where, message });
  const sheet = (wanted: string) => grid.sheets.find((s) => s.name.trim().toLowerCase() === wanted.toLowerCase());

  type Row = ItemRow & { at: string };
  const rows: Row[] = [];
  const items = sheet(SHEETS.items);
  if (items === undefined) say(SHEETS.items, "there is no Items sheet, so the plan is empty");
  else {
    const col = columnsOf(items, ITEM_COLUMNS, say);
    const seen = new Map<string, string>();
    for (const { row, cells } of items.rows) {
      const where = `${SHEETS.items} row ${row}`;
      const cell = (c: (typeof ITEM_COLUMNS)[number]) => (col[c] === undefined ? "" : (cells[col[c]!] ?? "")).trim();
      const ref = cell("Ref").toUpperCase();
      const title = cell("Title");
      if (ref === "") {
        say(where, `"${title || "a row"}" has no Ref, so it is not shown: give it one, such as the next free number in its group`);
        continue;
      }
      if (!isRef(ref)) {
        say(where, `"${ref}" is not a ref (capitals, a dash and a number, such as DATA-4), so the row is not shown`);
        continue;
      }
      if (seen.has(ref)) {
        say(where, `${ref} is also on ${seen.get(ref)}, so this row is not shown: give it a ref of its own`);
        continue;
      }
      seen.set(ref, where);
      if (title === "") say(where, `${ref} has no title`);
      let status = cell("Status").toLowerCase().replace(/\s+/g, "-");
      if (status === "") status = "to-do";
      else if (!STATUSES.includes(status)) {
        say(where, `${ref}'s status "${cell("Status")}" is not one of ${STATUSES.join(", ")}, so it shows as to-do`);
        status = "to-do";
      }
      const day = (field: "Start" | "Due"): string | undefined => {
        const d = cell(field);
        if (d === "") return undefined;
        if (isCalendarDate(d)) return d;
        say(where, `${ref}'s ${field.toLowerCase()} "${d}" is not a date as YYYY-MM-DD, so it is left out`);
        return undefined;
      };
      const body = (col.Body === undefined ? "" : (cells[col.Body] ?? "")).replace(/\r\n/g, "\n").trim();
      rows.push({ at: where, ref, title: title || ref, status, deps: splitRefs(cell("Depends on")), start: day("Start"), due: day("Due"), body: body || undefined });
    }
  }

  const known = new Set(rows.map((r) => r.ref));
  for (const r of rows) {
    r.deps = r.deps.filter((dep) => {
      if (dep === r.ref) say(r.at, `${r.ref} depends on itself, which is left out`);
      else if (!known.has(dep)) say(r.at, `${r.ref} depends on ${dep}, which is not on the Items sheet, so that is left out`);
      else return true;
      return false;
    });
    const parent = parentRef(r.ref);
    if (parent !== null && !known.has(parent)) say(r.at, `${r.ref} is under ${parent}, which is not on the Items sheet, so it shows at the top of its group`);
  }

  const next: string[] = [];
  const nextSheet = sheet(SHEETS.next);
  if (nextSheet !== undefined) {
    const col = columnsOf(nextSheet, NEXT_COLUMNS, say);
    const ranked: { ref: string; rank: number; row: number }[] = [];
    for (const { row, cells } of nextSheet.rows) {
      const where = `${SHEETS.next} row ${row}`;
      const rank = (col.Rank === undefined ? "" : (cells[col.Rank] ?? "")).trim();
      const ref = (col.Ref === undefined ? "" : (cells[col.Ref] ?? "")).trim().toUpperCase();
      if (rank === "") continue; // cleared: off the list
      if (!/^\d+(\.\d+)?$/.test(rank)) say(where, `rank "${rank}" is not a number, so ${ref || "the row"} is left off the list`);
      else if (!known.has(ref)) say(where, `${ref || "a row with no Ref"} is not on the Items sheet, so it is left off the list`);
      else ranked.push({ ref, rank: Number(rank), row });
    }
    if (new Set(ranked.map((r) => r.rank)).size !== ranked.length) say(SHEETS.next, "two rows share a rank, so the higher row goes first");
    for (const { ref } of ranked.sort((a, b) => a.rank - b.rank || a.row - b.row)) if (!next.includes(ref)) next.push(ref);
  }

  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plan";
  return {
    problems,
    store: {
      projects: [
        {
          key,
          name,
          type: "software",
          status: "active",
          id: idOf(`project:${key}`),
          created_at: at,
          updated_at: at,
          next,
          areas: [],
          items: rows.map((r) => ({
            ref: r.ref,
            area: r.ref.slice(0, r.ref.indexOf("-")),
            title: r.title,
            status: r.status,
            sort_path: sortPath(r.ref),
            ...(parentRef(r.ref) !== null && known.has(parentRef(r.ref)!) ? { parent: parentRef(r.ref)! } : {}),
            ...(r.deps.length > 0 ? { deps: r.deps } : {}),
            ...(r.start === undefined ? {} : { start: r.start }),
            ...(r.due === undefined ? {} : { due: r.due }),
            ...(r.body === undefined ? {} : { body: r.body }),
            id: idOf(`item:${r.ref}`),
            created_at: at,
            updated_at: at,
            ...(r.status === "done" ? { closed_at: at } : {}),
          })),
        },
      ],
    },
  };
}

/** Where each expected column is, by header, so a moved column still reads; a missing one is a problem. */
function columnsOf<C extends string>(sheet: GridSheet, expected: readonly C[], say: (at: string, message: string) => void): Partial<Record<C, number>> {
  const out: Partial<Record<C, number>> = {};
  const headers = sheet.headers.map((h) => h.trim().toLowerCase());
  for (const name of expected) {
    const at = headers.indexOf(name.toLowerCase());
    if (at === -1) say(sheet.name, `the ${name} column is missing`);
    else out[name] = at;
  }
  return out;
}
