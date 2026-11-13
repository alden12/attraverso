import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// Assert against the same source the viewer renders, so these numbers never drift from the store. That source
// is the fixture in e2e/fixture/ (built by its build.ts), not this repo's own plan: the plan is private and lives
// outside the package (DIST-3), and the open core's suite has to run in a checkout that has never seen it.
interface StoreItem {
  ref: string;
  area: string;
  status: string;
  deps?: string[];
  title: string;
  deleted_at?: string;
}
const project = (
  parse(readFileSync(new URL("./fixture/demo.apm.yaml", import.meta.url), "utf8")) as {
    projects: { name: string; items: StoreItem[]; next?: string[] }[];
  }
).projects[0]!;
// Soft-deleted items are excluded, because the viewer is served `asPlan` and never sees them (VIEW-15). The
// file keeps them - it is the durable copy, and `deleted_at` has to round-trip - so counting the file's items
// raw asserted a number the page can never show. It went unnoticed until the first ticket was deleted.
const items = project.items.filter((item) => item.deleted_at === undefined);
const areas = [...new Set(items.map((item) => item.area))];
// Dependencies naming another project (`PROJ-11`). Derived from the file rather than hardcoded, so the
// assertions hold as the split moves more items across.
const foreign = [...new Set(items.flatMap((item) => (item.deps ?? []).filter((dep) => dep.includes(":"))))];
const foreignProjects = [...new Set(foreign.map((dep) => dep.split(":")[0]!))];

/**
 * Toggle chips in the view settings dialog (VIEW-37), where the filters and layout controls live, then close it -
 * its backdrop would otherwise catch the next click meant for the graph or the calendar.
 */
async function settings(page: Page, ...chips: string[]): Promise<void> {
  await page.locator('.toolbtn[aria-haspopup="dialog"]').click();
  // An area's chip zooms to it in the graph (VIEW-36), and its eye beside it is the toggle, so that is clicked where
  // there is one; a status or a calendar's area chip is the toggle itself.
  for (const chip of chips) {
    const eye = page.locator(".settings").getByRole("button", { name: new RegExp(`^(Hide|Show) ${chip}$`) });
    await ((await eye.count()) > 0 ? eye : page.locator(".settings .chip", { hasText: chip }).first()).click();
  }
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings")).toHaveCount(0);
}

test.describe("the served store", () => {
  test.beforeEach(async ({ page }) => {
    // The manual layout persists in localStorage, so a stale drag from a previous run could otherwise move
    // nodes out of view and make a screenshot meaningless.
    await page.addInitScript(() => window.localStorage.clear());
    // Named, not "/": the dev server serves two store files here (`demo.apm.yaml` and `other.apm.yaml`, as a
    // split plan would be since `IMP-17`), so the bare root correctly shows the project picker instead of a
    // graph. `#demo` is the project this suite is about.
    await page.goto("/#demo");
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    // Finished work is hidden by default; this suite is about the whole plan, so it starts with all of it - and
    // waits for it, or a test's first count reads the map from before the done items came back.
    await settings(page, "done");
    await expect(page.locator('.toolbtn[aria-haspopup="dialog"]')).toContainText("all shown");
  });

  test("hides finished work until asked, and says so on the settings button", async ({ page }) => {
    await settings(page, "done"); // back to the default
    const done = items.filter((item) => item.status === "done").length;
    expect(done).toBeGreaterThan(0); // the fixture has finished work in it; guard the guard
    await expect(page.locator('.toolbtn[aria-haspopup="dialog"]')).toContainText(`${done} hidden`);
  });

  test("renders every area and item from the store", async ({ page }) => {
    // The title is the served project's own name now, not a hardcoded string: the viewer renders whichever
    // store `/api/store` hands it (VIEW-11), so this asserts it picked up the right one.
    await expect(page.locator(".topbar__title")).toContainText(project.name);
    // Which plan file this is lives at the top of the view dialog, with the project's name.
    await page.locator('.toolbtn[aria-haspopup="dialog"]').click();
    // Relative to the repo root (VIEW-48), which is `packages/core/...` here and `e2e/...` in the public repo.
    await expect(page.locator(".settings__head")).toHaveText(new RegExp(`^${project.name} - (.+/)?e2e/fixture/demo\\.apm\\.yaml$`));
    await page.keyboard.press("Escape");
    // Two projects are served, so the switcher is present and offers both (VIEW-4).
    await expect(page.locator(".picker")).toBeVisible();
    await expect(page.locator(".picker option")).toHaveCount(2);

    // This plan's own areas only: a foreign-project box is the same frame and would otherwise inflate the
    // count by one per project pointed at (`PROJ-11`).
    await expect(page.locator('.area-box:not([data-foreign="true"])')).toHaveCount(areas.length);
    // Leaf cards plus parent boxes account for every item; no marker may be silently dropped.
    const leaves = await page.locator(".item-node").count();
    const parents = await page.locator(".ticket-box").count();
    expect(leaves + parents).toBe(items.length);
  });

  test("draws a placeholder for every dependency that names another project (PROJ-11)", async ({ page }) => {
    // The items themselves live in `other.apm.yaml` and the viewer renders one project at a time, so there is
    // nothing here to draw an edge to. Each foreign ref gets a chip in a box named after its project.
    expect(foreign.length).toBeGreaterThan(0); // the fixture has cross-store edges in it; guard the guard
    await expect(page.locator('.area-box[data-foreign="true"]')).toHaveCount(foreignProjects.length);
    await expect(page.locator(".ghost-node")).toHaveCount(foreign.length);

    for (const project of foreignProjects) {
      await expect(page.locator('.area-box[data-foreign="true"] .area-box__name', { hasText: project })).toBeVisible();
    }
    // The ref is shown without its scope: the box already says which project, and repeating it in every chip
    // is noise.
    const [first] = foreign;
    await expect(page.locator(".ghost-node", { hasText: first!.split(":")[1]! }).first()).toBeVisible();
  });

  test("a placeholder is inert, because there is nothing to open", async ({ page }) => {
    await page.locator(".ghost-node").first().click();
    // No detail pane: selecting it would name an item this project does not have.
    await expect(page.locator(".detail")).toHaveCount(0);
  });

  test("opens the detail pane with the ticket's own prose", async ({ page }) => {
    await page.locator(".item-node", { hasText: "DATA-1" }).first().click();

    const detail = page.locator(".detail");
    await expect(detail.locator(".detail__id")).toHaveText("DATA-1");
    // In full, since the card clamps it and on a phone the pane covers the card (VIEW-44).
    await expect(detail.locator(".detail__title")).toHaveText(items.find((item) => item.ref === "DATA-1")!.title);
    // The body is the ticket's stored prose, so this proves the detail pane shows the right ticket's description.
    await expect(detail.locator(".detail__doc")).toContainText("Drizzle ORM over");
    await expect(detail.locator(".detail__deps")).toContainText("PLAT-1");
  });

  test("shows the status as a label, not a control, because the dev server may never write", async ({ page }) => {
    // The invariant this pins (VIEW-17): only the MCP-hosted viewer writes. This page is served by the Vite
    // dev server, a *second* process on the same file, and giving it a write path would be the two-writer
    // failure that lost a ticket on 2026-07-30. No token in the URL, so no control - and a plain label rather
    // than a disabled dropdown, since there is nothing here that could ever be enabled.
    await page.locator(".item-node", { hasText: "DATA-1" }).first().click();

    const detail = page.locator(".detail");
    await expect(detail.locator(".detail__status")).toBeVisible();
    await expect(detail.locator("select.detail__status")).toHaveCount(0);
  });

  test("navigates to a dependency from the detail pane", async ({ page }) => {
    await page.locator(".item-node", { hasText: "DATA-3" }).first().click();
    // Anchored: a ref is a prefix of its siblings' (DATA-1 of DATA-14), so a substring match is a trap here.
    await page.locator(".detail__dep", { hasText: /^DATA-1$/ }).click();

    await expect(page.locator(".detail__id")).toHaveText("DATA-1");
  });

  test("filters items out by area", async ({ page }) => {
    // Every leaf item is a card (a parent is drawn as a box instead). Waited for rather than read once, since the
    // cards redraw a frame after the toolbar's count does, and a read in between was the flake this used to have.
    const leaves = items.filter((item) => !items.some((other) => other.ref.startsWith(`${item.ref}.`))).length;
    await expect(page.locator(".item-node")).toHaveCount(leaves);
    const before = leaves;
    const platItems = items.filter((item) => item.area === "PLAT").length;

    await settings(page, "PLAT");

    await expect(page.locator('.toolbtn[aria-haspopup="dialog"]')).toContainText(`${platItems} hidden`);
    // Polled: the subtitle updates a frame before the re-layout drops the filtered cards.
    await expect.poll(() => page.locator(".item-node").count()).toBeLessThan(before);
  });

  test("zooms to an area from the view menu, showing it first if it was hidden (VIEW-36)", async ({ page }) => {
    await expect(page.locator(".item-node").first()).toBeVisible();
    const canvas = (await page.locator(".react-flow").boundingBox())!;
    const offCentre = async () => {
      const frame = await page.locator('.react-flow__node[data-id="area:PLAT"]').boundingBox();
      if (frame === null) return Infinity;
      return Math.round(Math.abs(frame.x + frame.width / 2 - (canvas.x + canvas.width / 2)) + Math.abs(frame.y + frame.height / 2 - (canvas.y + canvas.height / 2)));
    };

    await page.locator('.toolbtn[aria-haspopup="dialog"]').click();
    await page.getByRole("button", { name: "Hide PLAT" }).click();
    await expect(page.locator('.react-flow__node[data-id="area:PLAT"]')).toBeHidden();

    // The name goes there, bringing a hidden area back on the way.
    await page.locator(".settings .chip", { hasText: "PLAT" }).first().click();
    await expect(page.getByRole("button", { name: "Hide PLAT" })).toBeVisible();
    await expect.poll(offCentre).toBeLessThan(4);
  });

  test("hides and shows every area at once", async ({ page }) => {
    await expect(page.locator(".item-node").first()).toBeVisible();
    await page.locator('.toolbtn[aria-haspopup="dialog"]').click();
    await page.getByRole("button", { name: "hide all" }).click();
    await expect(page.locator(".item-node")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "hide all" })).toBeDisabled();
    await page.getByRole("button", { name: "show all" }).click();
    await expect(page.locator(".item-node").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "show all" })).toBeDisabled();
  });

  test("captures the full graph for visual inspection", async ({ page }) => {
    // Give the dagre layout and the fitView transition time to settle before capturing.
    await page.waitForTimeout(1200);
    await page.screenshot({ path: "test-results/roadmap-graph.png", fullPage: false });

    await page.locator(".item-node", { hasText: "DATA-5" }).first().click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/roadmap-detail.png", fullPage: false });
  });
});

/**
 * Switching between projects (VIEW-4). These serve a two-project store from a route mock rather than reading
 * the committed one: the thing under test is the viewer's own resolution of the URL against what it was
 * handed, and `/api/store` is exactly that seam. A fixture also keeps the assertions stable, which reading
 * the real store would not - it holds two projects since the `DIST-3` split and could hold more.
 */
test.describe("several projects in one store", () => {
  const TWO_PROJECTS = {
    path: "/tmp/two.apm.yaml",
    store: {
      projects: [
        { key: "apm", name: "AI PM", items: [{ ref: "MCP-1", area: "MCP", title: "the stdio server", status: "to-do" }] },
        { key: "spanish", name: "Spanish", items: [{ ref: "GRAM-1", area: "GRAM", title: "the subjunctive", status: "in-progress" }] },
      ],
    },
  };

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.route("**/api/store", (route) => route.fulfill({ json: TWO_PROJECTS }));
  });

  test("shows the agreed order on load, jumps to an item from it, and closes on request (PROJ-8)", async ({ page }) => {
    // A fixture, not the committed store: `next` is a live list that empties as work moves to review, so a
    // test reading it would assert nothing on the day it is empty and pass for the wrong reason on every other.
    await page.route("**/api/store", (route) =>
      route.fulfill({
        json: {
          path: "/tmp/one.apm.yaml",
          store: {
            projects: [
              {
                key: "apm",
                name: "AI PM",
                next: ["MCP-2", "MCP-1"],
                items: [
                  { ref: "MCP-1", area: "MCP", title: "the stdio server", status: "to-do" },
                  { ref: "MCP-2", area: "MCP", title: "the tool boundary", status: "in-progress" },
                ],
              },
            ],
          },
        },
      }),
    );
    await page.goto("/");
    await expect(page.locator(".react-flow__node").first()).toBeVisible();

    // Open on load, in the order agreed rather than the order the items are in.
    await expect(page.locator(".next__item")).toHaveCount(2);
    await expect(page.locator(".next__item").first()).toContainText("MCP-2");

    // The point of the panel: a jump list into the graph, not a second copy of it.
    await page.locator(".next__item").first().click();
    await expect(page.locator(".detail__id")).toHaveText("MCP-2");

    // Dismissible, to a floating button that keeps the count, so closing it does not hide that an order exists,
    // and opens it again.
    await page.locator(".next__close").click();
    await expect(page.locator(".next")).toHaveCount(0);
    await expect(page.locator(".next-fab", { hasText: "Next" })).toContainText("2");
    await page.locator(".next-fab", { hasText: "Next" }).click();
    await expect(page.locator(".next__item")).toHaveCount(2);
  });

  test("shows an item's measurements under its prose, summarised (METRIC-4)", async ({ page }) => {
    // A fixture for the same reason the order panel uses one: the committed store's measurements are live
    // data that will grow and change, so a test reading them asserts less every time it runs.
    await page.route("**/api/store", (route) =>
      route.fulfill({
        json: {
          path: "/tmp/one.apm.yaml",
          store: { projects: [{ key: "apm", name: "AI PM", items: [{ ref: "MCP-1", area: "MCP", title: "the stdio server", status: "to-do", body: "prose" }] }] },
          metrics: {
            apm: [
              { ref: "MCP-1", metric: "export_ms", count: 3, latest: 13, latestText: null, latestAt: "2026-09-03T16:00:00.000Z", firstAt: "2026-09-01T16:00:00.000Z", units: ["ms"], values: [], distinctValues: 0 },
              { ref: "MCP-1", metric: "body_weight", count: 2, latest: 172, latestText: null, latestAt: "2026-09-03T16:00:00.000Z", firstAt: "2026-09-02T16:00:00.000Z", units: ["kg", "lb"], values: [], distinctValues: 0 },
              { ref: "MCP-1", metric: "plan_save", count: 3, latest: null, latestText: null, latestAt: "2026-09-03T16:00:00.000Z", firstAt: "2026-09-01T16:00:00.000Z", units: [], values: [], distinctValues: 0 },
              { ref: "MCP-1", metric: "sleep_quality", count: 5, latest: null, latestText: "restless", latestAt: "2026-09-03T16:00:00.000Z", firstAt: "2026-09-01T16:00:00.000Z", units: [], values: [{ text: "restless", count: 3 }, { text: "sound", count: 2 }], distinctValues: 2 },
            ],
          },
        },
      }),
    );
    await page.goto("/#apm");
    await page.locator(".item-node", { hasText: "MCP-1" }).first().click();

    // A summary per metric, never a series: one row each however many readings there are.
    await expect(page.locator(".metrics__table tr")).toHaveCount(4);
    // A categorical reads as its distribution, which is what the latest value alone cannot say.
    await expect(page.locator(".metrics__table tr", { hasText: "sleep_quality" })).toContainText("restless x3, sound x2");
    await expect(page.locator(".metrics__table tr").first()).toContainText("3 readings");
    // Mixed units are marked here too, not only at the query layer.
    await expect(page.locator('.metrics__value[data-mixed="true"]')).toHaveCount(1);
    // A group node has no reading of its own, so its value cell is empty rather than showing a false dash -
    // and it counts occurrences, because "3 readings" is wrong for a row that has none.
    const group = page.locator(".metrics__table tr", { hasText: "plan_save" });
    await expect(group.locator(".metrics__value")).toHaveText("");
    await expect(group.locator(".metrics__count")).toContainText("3 occurrences");

    // Open by default, and collapsible - the count stays visible when closed, so a shut section still says
    // whether it holds anything.
    const heading = page.locator(".section__head", { hasText: "Metrics" });
    await expect(heading).toHaveAttribute("aria-expanded", "true");
    await heading.click();
    await expect(page.locator(".metrics__table")).toHaveCount(0);
    await expect(heading).toContainText("4");
    await heading.click();
    await expect(page.locator(".metrics__table")).toHaveCount(1);
  });

  test("shows no panel and no button when nobody has recorded an order", async ({ page }) => {
    // The state this project is in right now, which is exactly why the test above cannot use the live store.
    // The shared fixture holds two projects and no `next`, so the hash picks one and the panel has nothing.
    await page.goto("/#apm");
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(page.locator(".next")).toHaveCount(0);
    await expect(page.locator(".next-fab", { hasText: "Next" })).toHaveCount(0);
  });

  test("opens the first project when none is named, and offers the others (VIEW-31)", async ({ page }) => {
    await page.goto("/");

    // The first project's graph, with the switcher beside it naming every project, so the others are never
    // hidden - which was the reason the viewer used to prompt instead.
    await expect(page.locator(".item-node").first()).toBeVisible();
    await expect(page.locator(".picker")).toBeVisible();
    await expect(page.locator(".picker option")).toHaveCount(2);
  });

  test("switches project from the toolbar, and the URL follows so the link can be shared", async ({ page }) => {
    await page.goto("/");
    await page.selectOption(".picker", "spanish");

    expect(page.url()).toContain("#spanish");
    await expect(page.locator(".item-node", { hasText: "GRAM-1" })).toBeVisible();
    await expect(page.locator(".item-node", { hasText: "MCP-1" })).toHaveCount(0);
  });

  test("opens directly on the project named in the hash, which is what open_viewer hands back", async ({ page }) => {
    await page.goto("/#spanish");

    await expect(page.locator(".item-node", { hasText: "GRAM-1" })).toBeVisible();
    await expect(page.locator(".graph__notice")).toHaveCount(0);
  });

  test("says an unknown key is unknown, and names the real ones", async ({ page }) => {
    await page.goto("/#german");

    await expect(page.locator(".graph__notice")).toContainText('No project "german"');
    await expect(page.locator(".graph__notice")).toContainText("apm, spanish");
    await expect(page.locator(".item-node")).toHaveCount(0); // never a silent fallback to the first project
  });
});

/**
 * The calendar (`CAL-3`). From a route mock, with dates relative to today, so the items land in the month the
 * calendar opens on whatever day the suite runs.
 */
test.describe("the calendar", () => {
  // Tall enough that four items on one day fit without FullCalendar folding them into "+N more".
  test.use({ viewport: { width: 1280, height: 1400 } });
  const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const DATED = {
    path: "/tmp/dated.yaml",
    store: {
      projects: [
        {
          key: "apm",
          name: "AI PM",
          items: [
            { ref: "CAL-1", area: "CAL", title: "Dates on items", status: "done", due: day(0), body: "Calendar days, not timestamps." },
            { ref: "CAL-3", area: "CAL", title: "The calendar view", status: "in-progress", start: day(0), due: day(1) },
            { ref: "MCP-1", area: "MCP", title: "undated, so not on the calendar", status: "to-do" },
            // Done with no planned date: placed on the day it closed.
            { ref: "CAL-2", area: "CAL", title: "Finished, never planned", status: "done", closed_at: new Date().toISOString() },
          ],
        },
        { key: "spanish", name: "Spanish", items: [{ ref: "GRAM-1", area: "GRAM", title: "the subjunctive", status: "to-do", due: day(0) }] },
      ],
    },
  };

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.route("**/api/store", (route) => route.fulfill({ json: DATED }));
    // An item's prose comes from `/api/item` now (VIEW-29), so the mock answers that from the same fixture.
    await page.route("**/api/item?*", (route) => {
      const params = new URL(route.request().url()).searchParams;
      const project = DATED.store.projects.find((candidate) => candidate.key === params.get("project"));
      const item = project?.items.find((candidate) => candidate.ref === params.get("ref")) as { ref: string; body?: string } | undefined;
      return item === undefined
        ? route.fulfill({ status: 404, json: { error: "no such item" } })
        : route.fulfill({ json: { ref: item.ref, body: item.body ?? "", comments: [], attachments: [] } });
    });
    await page.goto("/#apm");
    await page.getByLabel("Show the calendar").click();
  });

  test("shows every project by default, and leaves undated items off", async ({ page }) => {
    // Finished work is hidden by default, which also makes room: three items on one day at this window size put
    // the third behind FullCalendar's "+1 more".
    await expect(page.locator(".cal__event", { hasText: "apm:CAL-3" }).first()).toBeVisible();
    await expect(page.locator(".cal__event", { hasText: "spanish:GRAM-1" })).toBeVisible();
    await expect(page.locator(".cal__event", { hasText: "MCP-1" })).toHaveCount(0);
    await page.screenshot({ path: "test-results/calendar-all.png", fullPage: false });
  });

  test("puts finished work on the day it closed", async ({ page }) => {
    await settings(page, "done");
    await expect(page.locator(".cal__event", { hasText: "apm:CAL-2" })).toBeVisible();
  });

  test("narrows to one project on request", async ({ page }) => {
    await settings(page, "all projects", "done"); // CAL-1 is finished
    await expect(page.locator(".cal__event", { hasText: "CAL-1" })).toBeVisible();
    await expect(page.locator(".cal__event", { hasText: "GRAM-1" })).toHaveCount(0);
    await page.screenshot({ path: "test-results/calendar.png", fullPage: false });
  });

  test("opens an item in the same detail pane, with its dates", async ({ page }) => {
    await settings(page, "done", "to-do"); // CAL-1 is finished; and room for it, by hiding GRAM-1
    await page.locator(".cal__event", { hasText: "CAL-1" }).click();
    await expect(page.locator(".detail__id")).toHaveText("CAL-1");
    await expect(page.locator(".detail")).toContainText("due");
    await expect(page.locator(".detail__doc")).toContainText("Calendar days, not timestamps.");
  });

  test("opens another project's item by switching to it", async ({ page }) => {
    await page.locator(".cal__event", { hasText: "spanish:GRAM-1" }).click();
    await expect(page).toHaveURL(/#spanish\/GRAM-1$/);
    await expect(page.locator(".detail__id")).toHaveText("GRAM-1");
    // Still the calendar: the view is a viewer preference, not a per-project one, so the switch keeps it.
    await expect(page.locator(".cal")).toBeVisible();
  });

  test("says why it is empty when nothing has a date", async ({ page }) => {
    // Areas are per-project, so their chips only appear with the calendar narrowed to one.
    await settings(page, "all projects");
    await settings(page, "CAL"); // hide the dated area, whose chip only appears once narrowed to one project
    await expect(page.locator(".graph__notice")).toContainText("Nothing here has a date yet");
  });
});

test.describe("the layout's memory (VIEW-23.1)", () => {
  test("puts every node back where it was after a reload", async ({ page }) => {
    // Cleared once rather than in an init script, which would run again on the reload and wipe what is tested.
    await page.goto("/#demo");
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    const positions = () =>
      page.locator(".react-flow__node").evaluateAll((nodes) =>
        Object.fromEntries(nodes.map((node) => [node.getAttribute("data-id"), (node as HTMLElement).style.transform])),
      );
    const before = await positions();
    expect(await page.evaluate(() => window.localStorage.getItem("roadmap.layout.v1:demo"))).not.toBeNull();

    await page.reload();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    expect(await positions()).toEqual(before);
  });
});

test.describe("the map follows the filters (VIEW-23.1)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto("/#demo");
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
  });

  const read = (page: Page) =>
    page.locator(".react-flow__node:visible").evaluateAll((nodes) =>
      Object.fromEntries(nodes.map((node) => [node.getAttribute("data-id"), (node as HTMLElement).style.transform])),
    );
  /** The positions once the layout has stopped moving: the first frame can land before it settles, and under a
   *  loaded runner a read taken then compares a half-drawn map. */
  const transforms = async (page: Page) => {
    let previous = await read(page);
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.waitForTimeout(100);
      const current = await read(page);
      if (JSON.stringify(current) === JSON.stringify(previous)) return current;
      previous = current;
    }
    return previous;
  };

  test("closes up around what a filter leaves, and opens back out exactly when it goes", async ({ page }) => {
    const before = await transforms(page);
    const area = areas[0]!;
    await settings(page, area);
    const filtered = await transforms(page);
    // Something visible moved in to fill the space, rather than leaving a hole where the area was.
    expect(Object.keys(filtered).some((id) => filtered[id] !== before[id])).toBe(true);
    await settings(page, area);
    expect(await transforms(page)).toEqual(before);
  });

  // Collapsing an area is the same move as a filter (VIEW-34), so it has to restore the map the same way.
  test("folds an area on a double-click, opens it on a click, and puts the map back exactly", async ({ page }) => {
    // An area with open work, since finished work is hidden by default and an area of it would not be drawn.
    const area = areas.find((key) => items.some((item) => item.area === key && item.status !== "done"))!;
    await expect(page.locator(".area-box--collapsed")).toHaveCount(0); // open by default
    const before = await transforms(page);

    await page.locator(".area-box__title", { hasText: area }).dblclick();
    await expect(page.locator(".area-box--collapsed")).toHaveCount(1);
    const folded = await transforms(page);
    expect(Object.keys(folded).filter((id) => id.startsWith(`${area}-`))).toEqual([]); // its cards are gone

    await page.locator(".area-box--collapsed").click();
    await expect(page.locator(".area-box--collapsed")).toHaveCount(0);
    expect(await transforms(page)).toEqual(before);
  });

  test("collapses and expands every area from the view settings", async ({ page }) => {
    const before = await transforms(page);
    await settings(page, "collapse all");
    await expect(page.locator(".area-box--collapsed").first()).toBeVisible();
    await expect(page.locator(".react-flow__node-item:visible")).toHaveCount(0);
    await settings(page, "expand all");
    await expect(page.locator(".area-box--collapsed")).toHaveCount(0);
    expect(await transforms(page)).toEqual(before);
  });
});

test.describe("moving cards (VIEW-41)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto("/#demo");
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
  });

  const drag = async (page: Page, id: string) => {
    const node = page.locator(`.react-flow__node[data-id="${id}"]`);
    const box = (await node.boundingBox())!;
    const before = await node.evaluate((element) => (element as HTMLElement).style.transform);
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 10, box.y + 160, { steps: 10 });
    await page.mouse.up();
    return { before, after: await node.evaluate((element) => (element as HTMLElement).style.transform) };
  };

  test("leaves a card where it is until it is selected, so a pan cannot move it", async ({ page }) => {
    const id = (await page.locator(".react-flow__node-item:visible").first().getAttribute("data-id"))!;
    const unselected = await drag(page, id);
    expect(unselected.after).toBe(unselected.before);
  });

  test("moves the selected card", async ({ page }) => {
    const id = (await page.locator(".react-flow__node-item:visible").first().getAttribute("data-id"))!;
    await page.locator(`.react-flow__node[data-id="${id}"]`).click();
    const selected = await drag(page, id);
    expect(selected.after).not.toBe(selected.before);
  });

  test("hides and shows the minimap on request, and remembers it", async ({ page }) => {
    await expect(page.locator(".react-flow__minimap")).toBeVisible();
    await page.getByLabel("Hide the minimap").click();
    await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
    // Remembered: read back from storage rather than across a reload, which this suite's init script clears. Per
    // screen size, so hiding it here (a desktop width) says nothing about a phone, and the reverse.
    expect(await page.evaluate(() => window.localStorage.getItem("attraverso.minimap.wide"))).toBe("hidden");
    expect(await page.evaluate(() => window.localStorage.getItem("attraverso.minimap.narrow"))).toBeNull();
    await page.getByLabel("Show the minimap").click();
    await expect(page.locator(".react-flow__minimap")).toBeVisible();
  });

  test("opens with the minimap on a wide screen even after it was hidden on a narrow one", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("attraverso.minimap.narrow", "hidden"));
    await page.reload();
    await expect(page.locator(".react-flow__minimap")).toBeVisible();
  });

  test("zooms out far enough to see the whole map", async ({ page }) => {
    // The floor used to be 0.2, too close for a plan of a few hundred items to fit on screen.
    const pane = (await page.locator(".react-flow").boundingBox())!;
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
    for (let step = 0; step < 40; step++) await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);
    const scale = await page.locator(".react-flow__viewport").evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
    expect(scale).toBeLessThan(0.1);
  });
});

test.describe("the project's context sections (VIEW-30)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto("/#demo");
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
  });

  const button = (page: Page) => page.locator(".next-fab", { hasText: "Context" });
  const pane = (page: Page) => page.locator('aside.detail[aria-label="Context"]');

  test("lists the headings, protocol first, and opens one in the pane with a link to it", async ({ page }) => {
    await expect(button(page)).toContainText("2");
    await button(page).click();
    await expect(pane(page).locator(".context__item")).toHaveText(["protocol", "Goals"]);

    await pane(page).locator(".context__item", { hasText: "Goals" }).click();
    await expect(pane(page).locator(".detail__title")).toHaveText("Goals");
    await expect(pane(page).locator(".detail__doc strong")).toHaveText("demo"); // rendered as markdown
    expect(decodeURIComponent(new URL(page.url()).hash)).toBe("#demo/context:Goals");

    // The link opens the same section on its own.
    await page.reload();
    await expect(pane(page).locator(".detail__title")).toHaveText("Goals");

    await pane(page).locator("button", { hasText: "‹ Context" }).click();
    await expect(pane(page).locator(".context__item")).toHaveCount(2);
  });

  test("shares the pane with items: opening one closes the other", async ({ page }) => {
    await button(page).click();
    await expect(pane(page)).toBeVisible();
    await page.locator(".react-flow__node-item").first().click();
    await expect(pane(page)).toHaveCount(0);
    await expect(page.locator("aside.detail .detail__title")).toBeVisible();

    await button(page).click();
    await expect(pane(page)).toBeVisible();
    await expect(page.locator("aside.detail")).toHaveCount(1);
  });
});

test.describe("searching the plan (VIEW-25)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto("/#demo");
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
  });

  const box = (page: Page) => page.locator(".search__input");
  const hits = (page: Page) => page.locator(".search__hit");

  test("finds an item as it is typed, and picking it selects it on the graph", async ({ page }) => {
    await page.keyboard.press("/");
    await box(page).fill("stdi"); // "stdio", still being typed
    await expect(hits(page).first()).toContainText("Serve the tools over stdio");
    await box(page).press("Enter");
    await expect(page.locator(".search")).toHaveCount(0);
    await expect(page.locator("aside.detail .detail__title")).toHaveText("Serve the tools over stdio");
  });

  test("goes straight to an item when a ref is typed", async ({ page }) => {
    await page.locator('.next-fab[aria-label="Search"]').click();
    await box(page).fill("view-1.2");
    await expect(hits(page).first()).toContainText("VIEW-1.2");
  });

  test("marks a hit the filters hide, and shows it when picked", async ({ page }) => {
    // Finished work is hidden by default, and PLAT-1 is done.
    await expect(page.locator('.react-flow__node[data-id="PLAT-1"]')).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await box(page).fill("scaffold");
    await expect(hits(page).first().locator(".search__hidden")).toHaveText("hidden");
    await hits(page).first().click();
    await expect(page.locator('.react-flow__node[data-id="PLAT-1"]')).toBeVisible();
    await expect(page.locator("aside.detail .detail__title")).toHaveText("Scaffold the repo");
  });

  test("opens a context section from a hit in it", async ({ page }) => {
    await page.keyboard.press("/");
    await box(page).fill("demo pla");
    await hits(page).filter({ hasText: "Goals" }).first().click();
    await expect(page.locator('aside.detail[aria-label="Context"] .detail__title')).toHaveText("Goals");
  });
});

test.describe("live refresh (VIEW-7)", () => {
  test("shows a change made elsewhere without a reload, and keeps the open item", async ({ page }) => {
    // Faked, so the test controls when the plan "changes": the version moves once, and the plan with it.
    let version = "v1";
    const plan = (title: string) => ({
      path: "/tmp/live.yaml",
      store: {
        projects: [
          {
            key: "apm",
            name: "AI PM",
            items: [
              { ref: "MCP-1", area: "MCP", title, status: "to-do", body: "prose" },
              { ref: "MCP-2", area: "MCP", title: "the tool boundary", status: "to-do" },
            ],
          },
        ],
      },
    });
    let current = plan("the stdio server");
    await page.route("**/api/store", (route) => route.fulfill({ json: current }));
    // The change stream, faked as one event per connection: each response ends, and EventSource reconnects after
    // the `retry` it was given, hearing the current token again - the same as a real stream announcing it.
    await page.route("**/api/changes", (route) =>
      route.fulfill({ contentType: "text/event-stream", body: `retry: 100\nevent: version\ndata: ${version}\n\n` }),
    );
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto("/#apm/MCP-2");
    await expect(page.locator(".react-flow__node-item", { hasText: "the stdio server" })).toBeVisible();
    await expect(page.locator("aside.detail .detail__title")).toHaveText("the tool boundary");
    // A marker on the window: a full page reload would wipe it, an in-place refresh does not.
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));

    current = plan("renamed by Claude");
    version = "v2";
    await expect(page.locator(".react-flow__node-item", { hasText: "renamed by Claude" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("aside.detail .detail__title")).toHaveText("the tool boundary");
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
  });

  test("adopts a layout changed on disk rather than saving its own back over it", async ({ page }) => {
    // A `git stash` that moves only the map: before this, the page kept its own positions and saved them straight
    // back, so the stash was undone a moment later and `git stash pop` conflicted.
    let version = "v1";
    let layout: Record<string, string> | undefined;
    const saves: Record<string, { x: number; y: number }>[] = [];
    const items = [
      { ref: "MCP-1", area: "MCP", title: "the stdio server", status: "to-do" },
      { ref: "MCP-2", area: "MCP", title: "the tool boundary", status: "to-do", deps: ["MCP-1"] },
      { ref: "DATA-1", area: "DATA", title: "the schema", status: "to-do" },
    ];
    await page.route("**/api/store", (route) =>
      route.fulfill({ json: { path: "/tmp/live.yaml", store: { projects: [{ key: "apm", name: "AI PM", items, ...(layout && { layout }) }] } } }),
    );
    await page.route("**/api/changes", (route) =>
      route.fulfill({ contentType: "text/event-stream", body: `retry: 100\nevent: version\ndata: ${version}\n\n` }),
    );
    await page.route("**/api/layout*", (route) => {
      saves.push((route.request().postDataJSON() as { layout: Record<string, { x: number; y: number }> }).layout);
      return route.fulfill({ json: {} });
    });
    await page.addInitScript(() => window.localStorage.clear());
    const toFile = (memory: Record<string, { x: number; y: number }>) => Object.fromEntries(Object.entries(memory).map(([id, at]) => [id, `${at.x},${at.y}`]));
    const frame = page.locator('.react-flow__node[data-id="area:DATA"]');
    const position = () => frame.evaluate((element) => (element as HTMLElement).style.transform);

    // First, a layout as the page itself would save it with DATA above MCP: the arranger's own output, as a
    // stashed layout file is, rather than one invented here, which the arranger would tidy and save.
    layout = { "area:DATA": "0,0", "area:MCP": "0,400" };
    await page.goto("/?t=token#apm"); // a write token, so the layout is the plan's to save, as on the MCP server's host
    await expect(frame).toBeVisible();
    await page.waitForTimeout(800);
    const dataFirst = toFile(saves.at(-1)!);

    // Then the page as it is opened today, laid out afresh with MCP first.
    layout = undefined;
    version = "v0";
    await page.reload();
    await expect(frame).toBeVisible();
    await page.waitForTimeout(800);
    const before = await position();
    const savedBefore = saves.length;

    // The file changes under it, as a `git stash` would change it.
    layout = dataFirst;
    version = "v1";
    await expect.poll(position).not.toBe(before);
    await page.waitForTimeout(800); // longer than the save's coalescing delay
    expect(saves.length).toBe(savedBefore);
  });

  test("asks a host without the stream once, and never again", async ({ page }) => {
    // An older local server, from before the stream: one failed request, then nothing.
    let asked = 0;
    await page.route("**/api/changes", (route) => {
      asked++;
      return route.fulfill({ status: 404, json: { error: "no such route" } });
    });
    await page.goto("/#demo");
    await expect(page.locator(".item-node").first()).toBeVisible();
    await page.waitForTimeout(1500);
    expect(asked).toBe(1);
  });
});

test.describe("an item's comments in the pane (VIEW-5, VIEW-29)", () => {
  test("loads the item when it is opened, and shows its comments last, Claude's folded", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    // Its body and comments come from `/api/item`, not the page load: the bulk feed no longer carries them.
    let itemFetched = false;
    page.on("request", (request) => {
      if (request.url().includes("/api/item?")) itemFetched = true;
    });
    await page.goto("/#demo/VIEW-1.2");
    const pane = page.locator("aside.detail");
    await expect(pane.locator(".detail__title")).toHaveText("Show an item's prose");

    const comments = pane.locator(".section", { hasText: "Comments" });
    await expect(comments.locator(".section__count")).toHaveText("2");
    // Folded to start with, its count showing on the heading; one click opens it, and it stays open from item to item.
    await expect(comments.locator(".comment")).toHaveCount(0);
    await comments.getByRole("button", { name: /Comments/ }).click();
    await expect(comments.locator(".comment")).toHaveCount(1);
    await expect(comments.locator(".comment")).toContainText("Moved to the pane");

    await comments.getByRole("button", { name: "Show Claude's note" }).click();
    await expect(comments.locator(".comment")).toHaveCount(2);
    // Newest first, so Claude's later note leads, rendered as markdown.
    await expect(comments.locator(".comment").first().locator("strong")).toHaveText("bold");
    expect(itemFetched).toBe(true);
  });
});
