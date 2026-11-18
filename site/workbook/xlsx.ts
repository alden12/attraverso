/**
 * The workbook as an `.xlsx` file (`DIST-9.2`): `model.ts`'s layout written out, and a file read back as a `Grid`.
 * The only place the spreadsheet library is used, so the model stays free of it.
 *
 * **ExcelJS**, as `DIST-9.2` chose: it keeps formatting through a rewrite better than SheetJS's free edition. A dev
 * dependency, bundled into the Pages site's own build and never into the published package or the cloud server,
 * which do not import `site/`. Bytes in and out, never a path, so the same code runs in Node and in a browser.
 *
 * **Real Excel tables**, not formatted ranges: a table grows by the row an assistant adds, carrying its dropdown and
 * formatting with it. The first cut pre-formatted 200 empty rows instead, and the stand-in test's new row landed
 * below all of them, at row 250.
 */
import ExcelJS from "exceljs";
import { STATUS_VALUES } from "../../scripts/tickets";
import { cellBody, ITEM_COLUMNS, NEXT_COLUMNS, readmeLines, SHEETS, type Grid, type WorkbookSnapshot } from "./model";

/** The workbook for a snapshot, as `.xlsx` bytes. */
export async function writeWorkbook(snapshot: WorkbookSnapshot): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "attraverso";

  const readme = wb.addWorksheet(SHEETS.readme);
  readmeLines(snapshot.project).forEach((line, n) => (readme.getCell(n + 1, 1).value = line));
  readme.getColumn(1).width = 140;
  readme.getCell(1, 1).font = { bold: true, size: 14 };

  const items = wb.addWorksheet(SHEETS.items, { views: [{ state: "frozen", ySplit: 1 }] });
  items.addTable({
    name: "Items",
    ref: "A1",
    headerRow: true,
    style: { theme: "TableStyleLight9", showRowStripes: true },
    columns: ITEM_COLUMNS.map((name) => ({ name, filterButton: true })),
    // A table needs at least one row; an empty project gets a blank one, which reads back as nothing.
    rows: snapshot.items.length > 0 ? snapshot.items.map((i) => [i.ref, i.title, i.status, i.parent, i.deps, i.start, i.due, cellBody(i.body), i.id]) : [ITEM_COLUMNS.map(() => "")],
  });
  [12, 60, 13, 10, 22, 12, 12, 100, 38].forEach((width, n) => (items.getColumn(n + 1).width = width));
  // Hidden rather than absent: it is what ties a row to its item whatever happens to the ref, and an assistant
  // that cannot see it cannot copy it onto a new row.
  items.getColumn(ITEM_COLUMNS.indexOf("id") + 1).hidden = true;
  const statusColumn = ITEM_COLUMNS.indexOf("Status") + 1;
  const bodyColumn = ITEM_COLUMNS.indexOf("Body") + 1;
  for (let row = 2; row <= Math.max(snapshot.items.length, 1) + 1; row++) {
    items.getCell(row, statusColumn).dataValidation = { type: "list", allowBlank: true, formulae: [`"${STATUS_VALUES.join(",")}"`] };
    items.getCell(row, bodyColumn).alignment = { wrapText: true, vertical: "top" };
  }

  const next = wb.addWorksheet(SHEETS.next, { views: [{ state: "frozen", ySplit: 1 }] });
  const titles = new Map(snapshot.items.map((i) => [i.ref, i.title]));
  next.addTable({
    name: "Next",
    ref: "A1",
    headerRow: true,
    style: { theme: "TableStyleLight9", showRowStripes: true },
    columns: NEXT_COLUMNS.map((name) => ({ name, filterButton: true })),
    rows: snapshot.next.length > 0 ? snapshot.next.map((ref, n) => [n + 1, ref, titles.get(ref) ?? ""]) : [NEXT_COLUMNS.map(() => "")],
  });
  [8, 12, 80].forEach((width, n) => (next.getColumn(n + 1).width = width));

  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/**
 * A cell as text, whatever an editor left in it: rich text flattened, a formula's last result, a date as the
 * calendar day it shows (Excel stores a typed date as a number, which ExcelJS hands back as a UTC midnight), a
 * hyperlink as its text, and an error as its code.
 */
export function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((run) => run.text).join("");
    if ("result" in value) return cellText((value.result ?? null) as ExcelJS.CellValue);
    if ("text" in value) return String(value.text);
    if ("error" in value) return String(value.error);
    return "";
  }
  return String(value);
}

/** Every sheet of an `.xlsx`, as text: its header row, its non-empty rows and which of its columns are hidden. */
export async function readWorkbook(bytes: Uint8Array): Promise<Grid> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return {
    sheets: wb.worksheets.map((ws) => {
      const width = ws.columnCount;
      const headers = Array.from({ length: width }, (_, n) => cellText(ws.getRow(1).getCell(n + 1).value).trim());
      const rows: Grid["sheets"][number]["rows"] = [];
      ws.eachRow({ includeEmpty: false }, (row, number) => {
        if (number === 1) return;
        const cells = Array.from({ length: width }, (_, n) => cellText(row.getCell(n + 1).value));
        if (cells.some((c) => c.trim() !== "")) rows.push({ row: number, cells });
      });
      return { name: ws.name, headers, rows, hiddenColumns: headers.filter((_, n) => ws.getColumn(n + 1).hidden) };
    }),
  };
}
