/**
 * A spreadsheet as the plan (`DIST-9.2`), over real `.xlsx` bytes: the template, rows edited the way an assistant in
 * Excel would, read back into a plan that loads. What matters as much as reading the right plan is that a bad row
 * is shown as best it can be and named as a problem, never a reason to show nothing.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { asPlan, importStore } from "../../src/serialise/plan";
import { createInMemoryDb } from "../../src/db/memory";
import { ITEM_COLUMNS, readPlan, type ItemRow } from "./model";
import { readWorkbook, writeWorkbook } from "./xlsx";

const AT = "2026-11-18T00:00:00.000Z";
let n = 0;
const idOf = () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`;

const ROWS: ItemRow[] = [
  { ref: "DATA-1", title: "Storage foundation", status: "done", deps: [] },
  { ref: "DATA-2", title: "The plan as YAML", status: "to-do", deps: ["DATA-1"], body: "Deterministic export." },
  { ref: "VIEW-1", title: "The graph viewer", status: "in-progress", deps: [], due: "2026-12-01" },
  { ref: "VIEW-1.1", title: "Lay out the graph", status: "review", deps: [] },
];

/** Open the bytes, add these rows to the Items table as an editor would, and hand back the new bytes. */
async function withRows(bytes: Uint8Array, rows: string[][], next?: (string | number)[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const items = wb.getWorksheet("Items")!;
  rows.forEach((cells) => items.addRow(cells));
  if (next !== undefined) next.forEach((cells) => wb.getWorksheet("Next")!.addRow(cells));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const read = async (bytes: Uint8Array) => readPlan(await readWorkbook(bytes), "Demo plan", AT, idOf);

describe("a spreadsheet as the plan (DIST-9.2)", () => {
  it("reads the blank template as an empty plan, with nothing wrong", async () => {
    const { store, problems } = await read(await writeWorkbook());
    expect(problems).toEqual([]);
    expect(store.projects[0]).toMatchObject({ key: "demo-plan", name: "Demo plan", items: [], next: [] });
  });

  it("reads items, nesting, dependencies, dates and the Next order, and the plan loads", async () => {
    const { store, problems } = await read(await writeWorkbook(ROWS, ["VIEW-1", "DATA-2"]));
    expect(problems).toEqual([]);
    const project = store.projects[0]!;
    expect(project.items.map((i) => [i.ref, i.status, i.parent ?? null, i.deps ?? []])).toEqual([
      ["DATA-1", "done", null, []],
      ["DATA-2", "to-do", null, ["DATA-1"]],
      ["VIEW-1", "in-progress", null, []],
      ["VIEW-1.1", "review", "VIEW-1", []],
    ]);
    expect(project.items.find((i) => i.ref === "VIEW-1")?.due).toBe("2026-12-01");
    expect(project.next).toEqual(["VIEW-1", "DATA-2"]);
    const { db } = await createInMemoryDb();
    await importStore(db, store);
    expect(asPlan(store).projects[0]!.items).toHaveLength(4);
  });

  it("reads rows an assistant added, fixing case and separators, and orders Next by rank, not row", async () => {
    const bytes = await withRows(await writeWorkbook(ROWS), [["data-3", "Migrations", "In Progress", "data-1; DATA-2"]], [
      [2, "DATA-3"],
      [1, "DATA-1"],
    ]);
    const { store, problems } = await read(bytes);
    expect(problems).toEqual([]);
    expect(store.projects[0]!.items.find((i) => i.ref === "DATA-3")).toMatchObject({ status: "in-progress", deps: ["DATA-1", "DATA-2"] });
    expect(store.projects[0]!.next).toEqual(["DATA-1", "DATA-3"]);
  });

  it("shows what it can of a bad row and names each problem against its row", async () => {
    const bytes = await withRows(await writeWorkbook(ROWS), [
      ["", "A row with no ref"],
      ["DATA 4", "A malformed ref"],
      ["DATA-1", "A second DATA-1"],
      ["DATA-5", "Mistyped status", "finished", "DATA-9", "next week"],
      ["DATA-6.1", "Under nothing"],
    ]);
    const { store, problems } = await read(bytes);
    const refs = store.projects[0]!.items.map((i) => i.ref);
    expect(refs).toEqual(["DATA-1", "DATA-2", "VIEW-1", "VIEW-1.1", "DATA-5", "DATA-6.1"]);
    expect(store.projects[0]!.items.find((i) => i.ref === "DATA-5")).toMatchObject({ status: "to-do" });
    expect(store.projects[0]!.items.find((i) => i.ref === "DATA-5")?.deps).toBeUndefined();
    expect(problems.map((p) => `${p.at}: ${p.message}`)).toEqual([
      'Items row 6: "A row with no ref" has no Ref, so it is not shown: give it one, such as the next free number in its group',
      'Items row 7: "DATA 4" is not a ref (capitals, a dash and a number, such as DATA-4), so the row is not shown',
      "Items row 8: DATA-1 is also on Items row 2, so this row is not shown: give it a ref of its own",
      'Items row 9: DATA-5\'s status "finished" is not one of done, review, in-progress, to-do, planning, so it shows as to-do',
      'Items row 9: DATA-5\'s start "next week" is not a date as YYYY-MM-DD, so it is left out',
      "Items row 9: DATA-5 depends on DATA-9, which is not on the Items sheet, so that is left out",
      "Items row 10: DATA-6.1 is under DATA-6, which is not on the Items sheet, so it shows at the top of its group",
    ]);
    const { db } = await createInMemoryDb();
    await importStore(db, store); // and it still loads
  });

  it("reads a moved column by its header, and names a missing one", async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Items");
    sheet.addRow(["Title", "Ref", "Status"]);
    sheet.addRow(["Moved columns", "DATA-1", "done"]);
    const { store, problems } = await read(new Uint8Array(await wb.xlsx.writeBuffer()));
    expect(store.projects[0]!.items[0]).toMatchObject({ ref: "DATA-1", title: "Moved columns", status: "done" });
    expect(problems.map((p) => p.message)).toEqual(ITEM_COLUMNS.filter((c) => !["Title", "Ref", "Status"].includes(c)).map((c) => `the ${c} column is missing`));
  });

  it("gives the same ref the same id on every read", async () => {
    const ids = new Map<string, string>();
    const stable = (key: string) => ids.get(key) ?? (ids.set(key, idOf()), ids.get(key)!);
    const bytes = await writeWorkbook(ROWS);
    const first = readPlan(await readWorkbook(bytes), "Demo", AT, stable).store.projects[0]!.items.map((i) => i.id);
    const again = readPlan(await readWorkbook(bytes), "Demo", AT, stable).store.projects[0]!.items.map((i) => i.id);
    expect(again).toEqual(first);
  });
});
