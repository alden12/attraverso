/**
 * The workbook as an `.xlsx` file (`DIST-9.2`): rows written out (the template, or a plan's items for a sample),
 * and a file read back as a `Grid`. The only place the spreadsheet library is used, so the model stays free of it.
 *
 * **ExcelJS**, as `DIST-9.2` chose: it keeps formatting through a rewrite better than SheetJS's free edition. A dev
 * dependency, bundled into the Pages site's own build and never into the published package or the cloud server,
 * which do not import `site/`. Bytes in and out, never a path, so the same code runs in Node and in a browser.
 *
 * **Real Excel tables**, not formatted ranges: a table grows by the row an assistant adds, carrying its dropdown and
 * formatting with it, and Copilot in Excel works on tables. The first cut pre-formatted 200 empty rows instead, and
 * the stand-in test's new row landed below all of them, at row 250.
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { STATUS_VALUES } from "../../scripts/tickets";
import { COMMENT_COLUMNS, CONTEXT_COLUMNS, ITEM_COLUMNS, NEXT_COLUMNS, PROJECT_COLUMNS, readmeLines, SHEETS, type Grid, type WorkbookContent } from "./model";

/** One sheet holding one table, with a frozen header and these column widths. A table needs at least one row, so an
 *  empty one gets a blank row, which reads back as nothing. */
function tableSheet(wb: ExcelJS.Workbook, name: string, columns: readonly string[], rows: (string | number)[][], widths: number[]): ExcelJS.Worksheet {
  const sheet = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.addTable({
    name: name.replace(/\W/g, ""),
    ref: "A1",
    headerRow: true,
    style: { theme: "TableStyleLight9", showRowStripes: true },
    columns: columns.map((c) => ({ name: c, filterButton: true })),
    rows: rows.length > 0 ? rows : [columns.map(() => "")],
  });
  widths.forEach((width, n) => (sheet.getColumn(n + 1).width = width));
  return sheet;
}

/** Long text wraps and sits at the top of its cell, in these columns of every row so far (and the blank one). */
function wrap(sheet: ExcelJS.Worksheet, column: number, rows: number) {
  for (let row = 2; row <= Math.max(rows, 1) + 1; row++) sheet.getCell(row, column).alignment = { wrapText: true, vertical: "top" };
}

/** A workbook of this content, as `.xlsx` bytes: with none, the blank template. */
export async function writeWorkbook(content: WorkbookContent = {}): Promise<Uint8Array> {
  const { items = [], next = [], comments = [], context = {} } = content;
  const wb = new ExcelJS.Workbook();
  wb.creator = "attraverso";

  const readme = wb.addWorksheet(SHEETS.readme);
  readmeLines().forEach((line, n) => (readme.getCell(n + 1, 1).value = line));
  readme.getColumn(1).width = 140;
  readme.getCell(1, 1).font = { bold: true, size: 14 };

  const project = tableSheet(wb, SHEETS.project, PROJECT_COLUMNS, [["Name", content.name ?? ""], ["Direction", content.direction ?? ""]], [14, 120]);
  wrap(project, 2, 2);

  const sheet = tableSheet(wb, SHEETS.items, ITEM_COLUMNS, items.map((i) => [i.ref, i.title, i.status, i.deps.join(", "), i.start ?? "", i.due ?? "", i.body ?? ""]), [12, 60, 13, 22, 12, 12, 100]);
  const statusColumn = ITEM_COLUMNS.indexOf("Status") + 1;
  for (let row = 2; row <= Math.max(items.length, 1) + 1; row++) {
    sheet.getCell(row, statusColumn).dataValidation = { type: "list", allowBlank: true, formulae: [`"${STATUS_VALUES.join(",")}"`] };
  }
  wrap(sheet, ITEM_COLUMNS.indexOf("Body") + 1, items.length);

  const titles = new Map(items.map((i) => [i.ref, i.title]));
  tableSheet(wb, SHEETS.next, NEXT_COLUMNS, next.map((ref, n) => [n + 1, ref, titles.get(ref) ?? ""]), [8, 12, 80]);

  const commentSheet = tableSheet(wb, SHEETS.comments, COMMENT_COLUMNS, comments.map((c) => [c.ref, c.comment, c.date ?? ""]), [12, 100, 12]);
  wrap(commentSheet, 2, comments.length);

  const sections = Object.entries(context);
  const contextSheet = tableSheet(wb, SHEETS.context, CONTEXT_COLUMNS, sections, [30, 120]);
  wrap(contextSheet, 2, sections.length);

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

/** Every sheet of an `.xlsx`, as text: its header row and its non-empty rows. */
export async function readWorkbook(bytes: Uint8Array): Promise<Grid> {
  const wb = await loadWorkbook(bytes);
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
      return { name: ws.name, headers, rows };
    }),
  };
}

/**
 * The workbook, repaired first if its document properties are the trouble. ExcelJS refuses a whole file over
 * `docProps/core.xml` written without the namespace prefixes Excel uses (`<lastModifiedBy>` rather than
 * `<cp:lastModifiedBy>`), which is what a file saved by a locked-down Copilot produced in the field (2026-11-19).
 * Those parts are only who saved it and with what, which the plan never reads, so a failed load swaps them for
 * minimal ones and tries again; anything else that fails, fails as it did.
 */
async function loadWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const load = async (data: Uint8Array) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data as unknown as ArrayBuffer);
    return wb;
  };
  try {
    return await load(bytes);
  } catch (first) {
    const zip = await JSZip.loadAsync(bytes).catch(() => null);
    if (zip === null || (zip.file("docProps/core.xml") === null && zip.file("docProps/app.xml") === null)) throw first;
    if (zip.file("docProps/core.xml") !== null) zip.file("docProps/core.xml", MINIMAL_CORE);
    if (zip.file("docProps/app.xml") !== null) zip.file("docProps/app.xml", MINIMAL_APP);
    try {
      return await load(await zip.generateAsync({ type: "uint8array" }));
    } catch {
      throw first;
    }
  }
}

const MINIMAL_CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"></cp:coreProperties>`;
const MINIMAL_APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"></Properties>`;
