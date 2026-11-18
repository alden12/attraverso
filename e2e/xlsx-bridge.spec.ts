/**
 * The xlsx bridge on the Pages site (`DIST-9.1`): a plan spreadsheet read in the browser, drawn by the viewer, and
 * followed as the file changes. The real file picker cannot be driven, so the page is handed a stand-in file in the
 * browser's own storage (the origin-private file system), holding a workbook written by the site's own writer.
 */
import { expect, test, type Page } from "@playwright/test";
import { SITE_PORT } from "../playwright.config";
import { writeWorkbook } from "../site/workbook/xlsx";
import type { ItemRow } from "../site/workbook/model";

const BRIDGE = `http://localhost:${SITE_PORT}/xlsx-bridge/`;
const ROWS: ItemRow[] = [
  { ref: "DATA-1", title: "Storage foundation", status: "done", deps: [] },
  { ref: "DATA-2", title: "The plan as YAML", status: "to-do", deps: ["DATA-1"] },
];
type Bridge = { writeSheet: (bytes: number[]) => Promise<void> };

/** Give the page a spreadsheet where it would show the picker, and a way to change it later. */
async function withSheet(page: Page, bytes: Uint8Array) {
  await page.addInitScript((first: number[]) => {
    const handle = async () => (await navigator.storage.getDirectory()).getFileHandle("plan.xlsx", { create: true });
    const write = async (bytes: number[]) => {
      const writable = await (await handle()).createWritable();
      await writable.write(new Uint8Array(bytes));
      await writable.close();
    };
    (window as unknown as Bridge).writeSheet = write;
    (window as unknown as { showOpenFilePicker: () => Promise<FileSystemFileHandle[]> }).showOpenFilePicker = async () => {
      await write(first);
      return [await handle()];
    };
  }, [...bytes]);
}

test("draws a plan spreadsheet, follows a change to it, lists its problems, and refuses to write", async ({ page }) => {
  await withSheet(page, await writeWorkbook(ROWS));
  await page.goto(`${BRIDGE}#plan`);
  await page.getByRole("button", { name: "Open the spreadsheet" }).click();
  await expect(page.getByText("The plan as YAML").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/problems? in the spreadsheet/)).toHaveCount(0);

  // The assistant edits the workbook: a renamed item (an open one: done ones are hidden by default), and a new one depending on something that is not there.
  const edited = await writeWorkbook([ROWS[0]!, { ...ROWS[1]!, title: "The plan as a spreadsheet" }, { ref: "DATA-3", title: "Migrations", status: "to-do", deps: ["DATA-9"] }]);
  await page.evaluate((bytes) => (window as unknown as Bridge).writeSheet(bytes), [...edited]);
  await expect(page.getByText("The plan as a spreadsheet").first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "1 problem in the spreadsheet" }).click();
  await expect(page.getByText("DATA-3 depends on DATA-9, which is not on the Items sheet")).toBeVisible();

  // Read only: a write route answers with the reason, rather than reaching anything.
  const refused = await page.evaluate(async () => {
    const response = await fetch("/api/ticket?project=plan&ref=DATA-1", { method: "POST", body: "{}" });
    return { status: response.status, body: (await response.json()) as { error: string } };
  });
  expect(refused.status).toBe(403);
  expect(refused.body.error).toContain("never changes it");
});

test("offers the template, and says which browsers can open the file, where this one cannot", async ({ page }) => {
  await page.addInitScript(() => delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker);
  await page.goto(BRIDGE);
  await expect(page.getByText("Opening the file needs Chrome or Edge")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download the template" }).click();
  expect((await download).suggestedFilename()).toBe("plan.xlsx");
});
