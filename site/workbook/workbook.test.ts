/**
 * The plan through a workbook and back (`DIST-9.2`), end to end over real `.xlsx` bytes: export, edit the file the
 * way an assistant in Excel would (cells, a new row, a deleted one), refresh against the export's snapshot and the
 * plan as it is now, and apply through the library. What matters as much as applying the right edits is that a
 * wrong one is reported against its row and never reaches the plan.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { openPlan, type Plan, type PlanProject } from "../../src/library";
import { parseStore } from "../../src/serialise/plan";
import { CELL_LIMIT, ITEM_COLUMNS, NEXT_COLUMNS, planRefresh, snapshotOf, type RefreshPlan, type WorkbookSnapshot } from "./model";
import { readWorkbook, writeWorkbook } from "./xlsx";
import { applyOperations } from "./apply";

/** A small plan: two areas, a child, a dependency, a sourced claim, and a Next list. */
async function seeded(): Promise<{ plan: Plan; demo: PlanProject }> {
  const plan = await openPlan();
  await plan.createProject({ key: "demo", name: "Demo", type: "software" });
  const demo = await plan.project("demo");
  await demo.createItem({ area: "DATA", title: "Storage foundation", status: "done" });
  await demo.createItem({ area: "DATA", title: "Migrations" });
  await demo.createItem({ area: "DATA", title: "The plan as YAML", deps: ["DATA-1"], body: "Deterministic export." });
  await demo.createItem({ area: "VIEW", title: "The graph viewer" });
  await demo.createItem({ parent: "VIEW-1", title: "Lay out the graph", status: "review" });
  await demo.setNext(["DATA-2", "DATA-3", "VIEW-1"]);
  return { plan, demo };
}

const snapshot = async (plan: Plan): Promise<WorkbookSnapshot> => snapshotOf(parseStore(await plan.toYaml()), "demo", "2026-11-18T00:00:00.000Z");

/** Open the workbook bytes, let `edit` change them as an editor would, and hand back the new bytes. */
async function edited(bytes: Uint8Array, edit: (sheets: { items: ExcelJS.Worksheet; next: ExcelJS.Worksheet }) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  edit({ items: wb.getWorksheet("Items")!, next: wb.getWorksheet("Next")! });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** The Items row holding `ref`, and a setter by column name. */
function row(items: ExcelJS.Worksheet, ref: string) {
  let found = 0;
  items.eachRow((r, n) => {
    if (r.getCell(1).value === ref) found = n;
  });
  if (found === 0) throw new Error(`no row for ${ref}`);
  return {
    number: found,
    set: (column: (typeof ITEM_COLUMNS)[number], value: ExcelJS.CellValue) => (items.getCell(found, ITEM_COLUMNS.indexOf(column) + 1).value = value),
  };
}

async function refresh(plan: Plan, base: WorkbookSnapshot, bytes: Uint8Array): Promise<RefreshPlan> {
  return planRefresh(base, await readWorkbook(bytes), await snapshot(plan));
}

const lines = (r: RefreshPlan, kind: string) => r.report.filter((l) => l.kind === kind).map((l) => `${l.at}: ${l.message}`);

describe("a plan through a workbook and back (DIST-9.2)", () => {
  it("reads an untouched export back as no change at all", async () => {
    const { plan } = await seeded();
    const base = await snapshot(plan);
    const result = await refresh(plan, base, await writeWorkbook(base));
    expect(result).toEqual({ operations: [], report: [] });
  });

  it("turns an assistant's edits into operations, applies them, and leaves a deleted row alone", async () => {
    const { plan, demo } = await seeded();
    const base = await snapshot(plan);
    const bytes = await edited(await writeWorkbook(base), ({ items, next }) => {
      row(items, "DATA-2").set("Status", "done");
      row(items, "DATA-3").set("Body", "A deterministic export, so a change is a one-line diff.");
      row(items, "DATA-3").set("Depends on", "DATA-1, DATA-2");
      row(items, "VIEW-1").set("Due", new Date(Date.UTC(2026, 11, 1))); // typed as a date, stored as a number
      items.addRow(["", "Zoom to fit", "", "VIEW-1", "VIEW-1.1", "", "", "", ""]);
      items.spliceRows(row(items, "DATA-1").number, 1);
      next.getCell(4, 1).value = 0; // VIEW-1 to the top, by rank
    });
    const result = await refresh(plan, base, bytes);
    expect(result.operations.map((o) => o.kind)).toEqual(["status", "edit", "edit", "create", "next"]);
    expect(lines(result, "flagged")).toEqual(["Items: DATA-1 is missing from the sheet. Deleted? Not applied: a deletion is asked for, never inferred"]);
    expect(lines(result, "refused")).toEqual([]);

    const applied = await applyOperations(demo, result.operations);
    expect(applied.every((a) => a.ok)).toBe(true);
    expect(applied.map((a) => a.outcome)).toContain('created VIEW-1.2 "Zoom to fit"');
    expect(await demo.getItem("DATA-2")).toMatchObject({ status: "done" });
    expect(await demo.getItem("DATA-3")).toMatchObject({ body: "A deterministic export, so a change is a one-line diff.", deps: ["DATA-1", "DATA-2"] });
    expect(await demo.getItem("VIEW-1")).toMatchObject({ due: "2026-12-01" });
    expect(await demo.getItem("VIEW-1.2")).toMatchObject({ status: "to-do", deps: ["VIEW-1.1"] });
    expect(await demo.getItem("DATA-1")).toMatchObject({ status: "done" });
    // Set as VIEW-1, DATA-2, DATA-3; DATA-2 is done now, and a done item is filtered on read.
    expect(await demo.getNext()).toEqual(["VIEW-1", "DATA-3"]);
  });

  it("fixes what is safe and says so: stray case and space, lower-case refs, a cleared id", async () => {
    const { plan } = await seeded();
    const base = await snapshot(plan);
    const bytes = await edited(await writeWorkbook(base), ({ items }) => {
      row(items, "DATA-2").set("Status", " In progress ");
      row(items, "DATA-3").set("Depends on", "data-1; data-2");
      row(items, "VIEW-1").set("id", null);
      row(items, "VIEW-1").set("Title", "The graph");
    });
    const result = await refresh(plan, base, bytes);
    expect(result.operations).toEqual([
      { kind: "status", at: "Items row 3", ref: "DATA-2", status: "in-progress" },
      { kind: "edit", at: "Items row 4", ref: "DATA-3", changes: { deps: ["DATA-1", "DATA-2"] } },
      { kind: "edit", at: "Items row 5", ref: "VIEW-1", changes: { title: "The graph" } },
    ]);
    expect(lines(result, "fixed")).toEqual([
      'Items row 3: status " In progress " read as in-progress',
      'Items row 4: depends on "data-1; data-2" read as "DATA-1, DATA-2"',
      "Items row 5: VIEW-1 had lost its id, so it was matched by its ref",
    ]);
  });

  it("files a row whose Parent is an area prefix at the top of that group, starting the group when it is new", async () => {
    const { plan, demo } = await seeded();
    const base = await snapshot(plan);
    const bytes = await edited(await writeWorkbook(base), ({ items }) => {
      items.addRow(["", "Index the comments", "", "DATA", "", "", "", "", ""]);
      items.addRow(["", "Write the README", "", "docs", "", "", "", "", ""]);
      items.addRow(["", "Record a demo", "", "DOCS", "", "", "", "", ""]);
    });
    const result = await refresh(plan, base, bytes);
    expect(result.operations.map((o) => (o.kind === "create" ? o.under : null))).toEqual([{ area: "DATA" }, { area: "DOCS" }, { area: "DOCS" }]);
    expect(lines(result, "note")).toEqual(['Items row 8: "Write the README" starts a new group, DOCS']);
    const applied = await applyOperations(demo, result.operations);
    expect(applied.map((a) => a.outcome)).toEqual(['created DATA-4 "Index the comments"', 'created DOCS-1 "Write the README"', 'created DOCS-2 "Record a demo"']);
  });

  it("refuses what is wrong, row by row, and applies the rest", async () => {
    const { plan } = await seeded();
    const base = await snapshot(plan);
    const bytes = await edited(await writeWorkbook(base), ({ items, next }) => {
      row(items, "DATA-2").set("Status", "finished");
      row(items, "DATA-3").set("Start", "next week");
      row(items, "VIEW-1").set("Title", "Graph");
      items.addRow(["", "Orphan", "", "", "", "", "", "", ""]);
      items.addRow(["", "Lost", "", "NOPE-1", "", "", "", "", ""]);
      next.getCell(2, 1).value = "first";
    });
    const result = await refresh(plan, base, bytes);
    expect(lines(result, "refused")).toEqual([
      'Items row 3: status "finished" is not one of done, review, in-progress, to-do, planning',
      'Items row 4: start "next week" is not a day as YYYY-MM-DD',
      'Items row 7: new item "Orphan" has no Parent, so there is nowhere to file it',
      'Items row 8: new item "Lost" is under NOPE-1, which is not an item in this plan',
      'Next row 2: rank "first" is not a number',
    ]);
    expect(result.operations).toEqual([{ kind: "edit", at: "Items row 5", ref: "VIEW-1", changes: { title: "Graph" } }, expect.objectContaining({ kind: "next" })]);
  });

  it("keeps the plan's version where it changed since the export too, and applies the rest of the row", async () => {
    const { plan, demo } = await seeded();
    const base = await snapshot(plan);
    // Edited in the viewer after the export: the title and the Next list.
    await demo.editItem("DATA-3", { title: "The plan as committed YAML" });
    await demo.setNext(["DATA-3"]);
    const bytes = await edited(await writeWorkbook(base), ({ items, next }) => {
      row(items, "DATA-3").set("Title", "YAML plans");
      row(items, "DATA-3").set("Status", "done");
      next.getCell(2, 1).value = 9;
    });
    const result = await refresh(plan, base, bytes);
    expect(lines(result, "conflict")).toEqual([
      "Items row 4: DATA-3's title was changed in the plan since the export too, so the plan's was kept",
      "Next: the Next list was changed in the plan since the export too, so the plan's was kept",
    ]);
    expect(result.operations).toEqual([{ kind: "status", at: "Items row 4", ref: "DATA-3", status: "done" }]);
  });

  it("flags a copied row, an invented id, a changed ref and a dropped source pointer", async () => {
    const { plan, demo } = await seeded();
    await demo.editItem("DATA-3", { body: "Deterministic export." });
    const base = await snapshot(plan);
    const bytes = await edited(await writeWorkbook(base), ({ items }) => {
      const copied = items.getRow(row(items, "DATA-2").number).values as ExcelJS.CellValue[];
      items.addRow(copied.slice(1));
      items.addRow(["", "Made up", "", "VIEW-1", "", "", "", "", "01a1e12c-0000-7000-8000-000000000000"]);
      row(items, "VIEW-1").set("Ref", "VIEW-9");
    });
    const result = await refresh(plan, base, bytes);
    expect(lines(result, "flagged")).toEqual([
      "Items row 5: VIEW-1's ref was changed to \"VIEW-9\": renaming is not done from the workbook, so not applied",
      "Items row 7: same id as Items row 3, so probably a copied row: not applied",
      "Items row 8: its id is not one this workbook was exported with: not applied",
    ]);
    expect(result.operations).toEqual([]);
  });

  it("warns when a body edit drops a source pointer, and still applies it", async () => {
    const plan = await openPlan();
    await plan.createProject({ key: "demo", name: "Demo", type: "software" });
    const demo = await plan.project("demo");
    await demo.createItem({ area: "DATA", title: "Storage", body: "Postgres 18 runs in production [ref pg18]." });
    await demo.setNext([]);
    const base = await snapshot(plan);
    const bytes = await edited(await writeWorkbook(base), ({ items }) => row(items, "DATA-1").set("Body", "Postgres runs in production."));
    const result = await refresh(plan, base, bytes);
    expect(lines(result, "flagged")).toEqual(["Items row 2: DATA-1's new body drops [ref pg18], which retires the sources behind that claim"]);
    expect(result.operations).toEqual([{ kind: "edit", at: "Items row 2", ref: "DATA-1", changes: { body: "Postgres runs in production." } }]);
  });

  it("reads Next by rank, not row order, and says so when only rows moved", async () => {
    const { plan } = await seeded();
    const base = await snapshot(plan);
    const bytes = await edited(await writeWorkbook(base), ({ next }) => {
      // Swap the first two rows' contents, ranks and all: the order by rank is unchanged.
      const a = next.getRow(2).values as ExcelJS.CellValue[];
      const b = next.getRow(3).values as ExcelJS.CellValue[];
      NEXT_COLUMNS.forEach((_, n) => {
        next.getCell(2, n + 1).value = b[n + 1] ?? null;
        next.getCell(3, n + 1).value = a[n + 1] ?? null;
      });
    });
    const result = await refresh(plan, base, bytes);
    expect(result.operations).toEqual([]);
    expect(lines(result, "note")).toEqual(["Next: rows were moved but no rank changed, so the order is unchanged: the Rank column is what counts"]);
  });

  it("exports a body too long for a cell cut short, and refuses an edit to it", async () => {
    const plan = await openPlan();
    await plan.createProject({ key: "demo", name: "Demo", type: "software" });
    const demo = await plan.project("demo");
    await demo.createItem({ area: "DATA", title: "Long", body: "x".repeat(CELL_LIMIT + 10) });
    const base = await snapshot(plan);
    const untouched = await refresh(plan, base, await writeWorkbook(base));
    expect(untouched.operations).toEqual([]);
    const bytes = await edited(await writeWorkbook(base), ({ items }) => row(items, "DATA-1").set("Body", "short now"));
    expect(lines(await refresh(plan, base, bytes), "refused")).toEqual([
      "Items row 2: DATA-1's body is too long for a cell, so it was exported cut short and cannot be edited here",
    ]);
  });

  it("reports the plan's refusal against its row and applies the rest", async () => {
    const { plan, demo } = await seeded();
    const base = await snapshot(plan);
    // DATA-1 depending on DATA-3 closes a cycle, which only the plan can see.
    const bytes = await edited(await writeWorkbook(base), ({ items }) => {
      row(items, "DATA-1").set("Depends on", "DATA-3");
      row(items, "DATA-2").set("Title", "Schema migrations");
    });
    const applied = await applyOperations(demo, (await refresh(plan, base, bytes)).operations);
    expect(applied.map((a) => a.ok)).toEqual([false, true]);
    expect(applied[0]!.outcome).toMatch(/cycle/i);
    expect(await demo.getItem("DATA-2")).toMatchObject({ title: "Schema migrations" });
  });
});
