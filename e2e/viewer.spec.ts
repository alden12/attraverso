import { expect, test } from "@playwright/test";
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
  });

  test("renders every area and item from the store", async ({ page }) => {
    // The title is the served project's own name now, not a hardcoded string: the viewer renders whichever
    // store `/api/store` hands it (VIEW-11), so this asserts it picked up the right one.
    await expect(page.locator(".topbar__title")).toContainText(project.name);
    await expect(page.locator(".topbar__sub")).toContainText(`${items.length} of ${items.length} items`);
    await expect(page.locator(".topbar__sub")).toContainText("demo.apm.yaml");
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
    const before = await page.locator(".item-node").count();
    const platItems = items.filter((item) => item.area === "PLAT").length;

    await page.locator(".chip", { hasText: "PLAT" }).first().click();

    await expect(page.locator(".topbar__sub")).toContainText(`${items.length - platItems} of ${items.length}`);
    expect(await page.locator(".item-node").count()).toBeLessThan(before);
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

    // Dismissible, and the chip keeps the count so closing it does not hide that an order exists.
    await page.locator(".chip", { hasText: "next" }).first().click();
    await expect(page.locator(".next")).toHaveCount(0);
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

  test("shows no panel and no chip when nobody has recorded an order", async ({ page }) => {
    // The state this project is in right now, which is exactly why the test above cannot use the live store.
    // The shared fixture holds two projects and no `next`, so the hash picks one and the panel has nothing.
    await page.goto("/#apm");
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(page.locator(".next")).toHaveCount(0);
    await expect(page.locator(".chip", { hasText: "next" })).toHaveCount(0);
  });

  test("prompts for a project rather than picking one, and offers them all", async ({ page }) => {
    await page.goto("/");

    // The bug this replaces was rendering `projects[0]` with no sign the other existed.
    await expect(page.locator(".graph__notice")).toContainText("Choose one");
    await expect(page.locator(".item-node")).toHaveCount(0);
    await expect(page.locator(".picker")).toBeVisible();
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
    await page.goto("/#apm");
    await page.locator(".segmented__btn", { hasText: "calendar" }).click();
  });

  test("shows every project by default, and leaves undated items off", async ({ page }) => {
    // Status filters apply across projects. Also makes room: three items on one day at this window size put
    // the third behind FullCalendar's "+1 more".
    await page.locator(".chip", { hasText: "done" }).click();
    await expect(page.locator(".cal__event", { hasText: "apm:CAL-3" }).first()).toBeVisible();
    await expect(page.locator(".cal__event", { hasText: "spanish:GRAM-1" })).toBeVisible();
    await expect(page.locator(".cal__event", { hasText: "MCP-1" })).toHaveCount(0);
    await page.screenshot({ path: "test-results/calendar-all.png", fullPage: false });
  });

  test("puts finished work on the day it closed", async ({ page }) => {
    await expect(page.locator(".cal__event", { hasText: "apm:CAL-2" })).toBeVisible();
  });

  test("narrows to one project on request", async ({ page }) => {
    await page.locator(".chip", { hasText: "all projects" }).click();
    await expect(page.locator(".cal__event", { hasText: "CAL-1" })).toBeVisible();
    await expect(page.locator(".cal__event", { hasText: "GRAM-1" })).toHaveCount(0);
    await page.screenshot({ path: "test-results/calendar.png", fullPage: false });
  });

  test("opens an item in the same detail pane, with its dates", async ({ page }) => {
    await page.locator(".chip", { hasText: "to-do" }).click(); // room for CAL-1, by hiding GRAM-1
    await page.locator(".cal__event", { hasText: "CAL-1" }).click();
    await expect(page.locator(".detail__id")).toHaveText("CAL-1");
    await expect(page.locator(".detail")).toContainText("due");
    await expect(page.locator(".detail__doc")).toContainText("Calendar days, not timestamps.");
  });

  test("opens another project's item by switching to it", async ({ page }) => {
    await page.locator(".chip", { hasText: "done" }).click(); // room for all three, as above
    await page.locator(".cal__event", { hasText: "spanish:GRAM-1" }).click();
    await expect(page).toHaveURL(/#spanish\/GRAM-1$/);
    await expect(page.locator(".detail__id")).toHaveText("GRAM-1");
    // Still the calendar: the view is a viewer preference, not a per-project one, so the switch keeps it.
    await expect(page.locator(".cal")).toBeVisible();
  });

  test("says why it is empty when nothing has a date", async ({ page }) => {
    // Areas are per-project, so their chips only appear with the calendar narrowed to one.
    await page.locator(".chip", { hasText: "all projects" }).click();
    await page.locator(".chip", { hasText: "CAL" }).click(); // hide the dated area
    await expect(page.locator(".graph__notice")).toContainText("Nothing here has a date yet");
  });
});
