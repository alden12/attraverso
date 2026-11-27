/**
 * The xlsx bridge on the Pages site (`DIST-9.1`): a plan spreadsheet read in the browser, drawn by the viewer, and
 * followed as the folder changes. The real folder picker cannot be driven, so the page is handed a stand-in folder in
 * the browser's own storage (the origin-private file system), holding workbooks written by the site's own writer.
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
type Bridge = { writeSheet: (name: string, bytes: number[]) => Promise<void>; mirrorFiles: () => Promise<string[]> };

/**
 * Give the page a folder holding `plan.xlsx` where it would show the picker (and an empty one when it asks for a
 * folder to write copies to), and ways to write into the first and list the second.
 */
async function withSheet(page: Page, bytes: Uint8Array) {
  await page.addInitScript((first: number[]) => {
    const folder = async (name: string) => (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
    const write = async (name: string, bytes: number[]) => {
      const writable = await (await (await folder("source")).getFileHandle(name, { create: true })).createWritable();
      await writable.write(new Uint8Array(bytes));
      await writable.close();
    };
    const bridge = window as unknown as Bridge;
    bridge.writeSheet = write;
    bridge.mirrorFiles = async () => {
      const names: string[] = [];
      for await (const name of (await folder("mirror") as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
      return names.sort();
    };
    (window as unknown as { showDirectoryPicker: (o: { mode: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async ({ mode }) => {
      if (mode === "readwrite") return folder("mirror");
      await write("plan.xlsx", first);
      return folder("source");
    };
  }, [...bytes]);
}

test("draws a plan spreadsheet, follows a change to it, lists its problems, and refuses to write", async ({ page }) => {
  await withSheet(page, await writeWorkbook({ items: ROWS, context: { "How we store it": "One spreadsheet, read in the browser." } }));
  // No server here serves an optional package's tab, so the page says `extensionTabs: false` and never asks for them.
  const askedForTabs: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/api/extensions")) askedForTabs.push(request.url());
  });
  // Opened on a context section, so the Context sheet is shown to reach the viewer as well as the items.
  await page.goto(`${BRIDGE}#plan/context:How%20we%20store%20it`);
  await page.getByRole("button", { name: "Open the folder" }).click();
  await expect(page.getByText("The plan as YAML").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/problems? in the spreadsheet/)).toHaveCount(0);
  await expect(page.getByText("One spreadsheet, read in the browser.")).toBeVisible();
  expect(askedForTabs).toEqual([]);

  // The assistant edits the workbook: a renamed item (an open one: done ones are hidden by default), and a new one depending on something that is not there.
  const edited = await writeWorkbook({ items: [ROWS[0]!, { ...ROWS[1]!, title: "The plan as a spreadsheet" }, { ref: "DATA-3", title: "Migrations", status: "to-do", deps: ["DATA-9"] }] });
  await page.evaluate((bytes) => (window as unknown as Bridge).writeSheet("plan.xlsx", bytes), [...edited]);
  await expect(page.getByText("The plan as a spreadsheet").first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "1 problem in the spreadsheet" }).click();
  await expect(page.getByText("DATA-3 depends on DATA-9, which is not on the Items sheet")).toBeVisible();

  // An assistant that cannot edit a file saves a new version beside it: the page switches to it.
  const v2 = await writeWorkbook({ items: [ROWS[0]!, { ...ROWS[1]!, title: "The plan, version two" }] });
  await page.evaluate((bytes) => (window as unknown as Bridge).writeSheet("plan_v2.xlsx", bytes), [...v2]);
  await expect(page.getByText("The plan, version two").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/problems? in the spreadsheet/)).toHaveCount(0);

  // Read only: a write route answers with the reason, rather than reaching anything.
  const refused = await page.evaluate(async () => {
    const response = await fetch("/api/ticket?project=plan&ref=DATA-1", { method: "POST", body: "{}" });
    return { status: response.status, body: (await response.json()) as { error: string } };
  });
  expect(refused.status).toBe(403);
  expect(refused.body.error).toContain("never changes it");
});

test("keeps a copy of every version in a folder of the user's, never overwriting one", async ({ page }) => {
  await withSheet(page, await writeWorkbook({ items: ROWS }));
  await page.goto(`${BRIDGE}#plan`);
  await page.getByRole("button", { name: "Open the folder" }).click();
  await expect(page.getByText("The plan as YAML").first()).toBeVisible({ timeout: 30_000 });
  const mirrored = () => page.evaluate(() => (window as unknown as Bridge).mirrorFiles());

  // Off until asked: nothing is written.
  expect(await mirrored()).toEqual([]);
  // Rarely set, so in the viewer's menu.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "keep copies in a folder" }).click();
  await expect.poll(mirrored).toEqual(["plan.xlsx"]);

  // A new version is copied as it appears.
  const v2 = await writeWorkbook({ items: [ROWS[0]!, { ...ROWS[1]!, title: "The plan, version two" }] });
  await page.evaluate((bytes) => (window as unknown as Bridge).writeSheet("plan_v2.xlsx", bytes), [...v2]);
  await expect(page.getByText("The plan, version two").first()).toBeVisible({ timeout: 10_000 });
  await expect.poll(mirrored).toEqual(["plan.xlsx", "plan_v2.xlsx"]);
  // The menu stayed open, and says what was copied last.
  await expect(page.getByText("Copied plan_v2.xlsx to mirror")).toBeVisible();

  // A version edited in place is copied again, and the copy it replaces is kept beside it.
  const v2b = await writeWorkbook({ items: [ROWS[0]!, { ...ROWS[1]!, title: "Version two, edited" }] });
  await page.evaluate((bytes) => (window as unknown as Bridge).writeSheet("plan_v2.xlsx", bytes), [...v2b]);
  await expect(page.getByText("Version two, edited").first()).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await mirrored()).filter((name) => name.endsWith(".bak")).length).toBe(1);
  expect((await mirrored()).filter((name) => !name.endsWith(".bak"))).toEqual(["plan.xlsx", "plan_v2.xlsx"]);
});

test("offers the template, and says which browsers can open the folder, where this one cannot", async ({ page }) => {
  await page.addInitScript(() => delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker);
  await page.goto(BRIDGE);
  await expect(page.getByText("Opening the folder needs Chrome or Edge")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download the template" }).click();
  expect((await download).suggestedFilename()).toBe("plan.xlsx");
});
