/**
 * `/open` on the Pages site (`DIST-9.1`): a plan folder read in the browser, drawn by the viewer, and followed as
 * its files change. The real folder picker cannot be driven, so the page is handed a stand-in folder in the
 * browser's own storage (the origin-private file system), holding the fixture's demo plan and its references file.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SITE_PORT } from "../playwright.config";

const OPEN = `http://localhost:${SITE_PORT}/open/`;
const PLAN = readFileSync("e2e/fixture/demo.apm.yaml", "utf8");
const FILES = { "demo.apm.yaml": PLAN, ".apm/references.yaml": readFileSync("e2e/fixture/.apm/references.yaml", "utf8") };

/** Give the page a folder of these files where it would show the picker, and a way to change one later. */
async function withFolder(page: Page) {
  await page.addInitScript((files: Record<string, string>) => {
    const write = async (name: string, text: string) => {
      let dir = await navigator.storage.getDirectory();
      const parts = name.split("/");
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    };
    (window as unknown as { writeFile: typeof write }).writeFile = write;
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => {
      for (const [name, text] of Object.entries(files)) await write(name, text);
      return navigator.storage.getDirectory();
    };
  }, FILES);
}

test("draws a plan folder, follows a change to its file, and refuses to write", async ({ page }) => {
  await withFolder(page);
  await page.goto(`${OPEN}#demo`);
  await page.getByRole("button", { name: "Choose a folder" }).click();
  await expect(page.getByText("The plan as YAML").first()).toBeVisible({ timeout: 30_000 });

  // An agent edits the plan file: the page notices within a couple of seconds and redraws.
  const edited = PLAN.replace("title: The plan as YAML", "title: The plan as committed YAML");
  expect(edited).not.toBe(PLAN);
  await page.evaluate((text) => (window as unknown as { writeFile: (n: string, t: string) => Promise<void> }).writeFile("demo.apm.yaml", text), edited);
  await expect(page.getByText("The plan as committed YAML").first()).toBeVisible({ timeout: 10_000 });

  // Read only: a write route answers with the reason, rather than reaching anything.
  const refused = await page.evaluate(async () => {
    const response = await fetch("/api/ticket?project=demo&ref=DATA-3", { method: "POST", body: "{}" });
    return { status: response.status, body: (await response.json()) as { error: string } };
  });
  expect(refused.status).toBe(403);
  expect(refused.body.error).toContain("read-only");
});

test("says which browsers can open a folder, where this one cannot", async ({ page }) => {
  await page.addInitScript(() => delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker);
  await page.goto(OPEN);
  await expect(page.getByText("This needs Chrome or Edge")).toBeVisible();
});
