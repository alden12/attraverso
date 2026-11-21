/**
 * The four states VIEW-4 has to get right. They are one rule: never choose silently among alternatives. The
 * bug being fixed was `store.projects[0]`, which did exactly that, and each case here is a way of doing it
 * again by accident.
 */
import { describe, expect, it } from "vitest";
import { emptyViewNotice, orderSections, parseHash, sectionInFocus, selectProject, type ProjectPlan } from "./store";
import type { RoadmapItem } from "../scripts/tickets";

const project = (key: string): ProjectPlan => ({ key, name: key.toUpperCase(), items: [], next: [], layout: {}, metrics: new Map(), context: [], file: null, areaInfo: {}, areaOrder: [] });
const apm = project("apm");
const spanish = project("spanish");

describe("selectProject", () => {
  it("renders the only project without asking, since there is no ambiguity to resolve", () => {
    expect(selectProject([apm], null)).toEqual({ project: apm, notice: null });
  });

  it("opens the first project when none is named, since the switcher shows the rest (VIEW-31)", () => {
    expect(selectProject([apm, spanish], null)).toEqual({ project: apm, notice: null });
  });

  it("renders the project named in the hash", () => {
    expect(selectProject([apm, spanish], "spanish")).toEqual({ project: spanish, notice: null });
  });

  it("says an unknown key is unknown, and what is there, instead of falling back", () => {
    const selection = selectProject([apm, spanish], "german");
    expect(selection.project).toBeNull();
    expect(selection.notice).toContain('No project "german"');
    expect(selection.notice).toContain("apm, spanish");
  });

  it("treats an empty store as a first run, hash or no hash", () => {
    for (const requested of [null, "apm"]) {
      const selection = selectProject([], requested);
      expect(selection.project).toBeNull();
      expect(selection.notice).toContain("no projects yet");
    }
  });
});

describe("parseHash", () => {
  it("reads a project, and an item in it when one is named (CAL-3)", () => {
    expect(parseHash("")).toEqual({ project: null, item: null });
    expect(parseHash("#apm")).toEqual({ project: "apm", item: null });
    expect(parseHash("#apm/CAL-1.2")).toEqual({ project: "apm", item: "CAL-1.2" });
    // A trailing slash names no item, rather than an item called "".
    expect(parseHash("#apm/")).toEqual({ project: "apm", item: null });
    expect(parseHash("#my%20plan/CAL-1")).toEqual({ project: "my plan", item: "CAL-1" });
  });
});

describe("context sections (VIEW-30)", () => {
  it("puts protocol first and keeps the project's order for the rest", () => {
    expect(orderSections({ thesis: "a", protocol: "b", storage: "c" }).map((s) => s.heading)).toEqual(["protocol", "thesis", "storage"]);
  });

  it("reads a section from the hash's second half, and leaves an item ref alone", () => {
    expect(sectionInFocus(parseHash("#apm/context%3AThe%20storage%20model").item)).toBe("The storage model");
    expect(sectionInFocus(parseHash("#apm/VIEW-30").item)).toBeNull();
    expect(sectionInFocus(null)).toBeNull();
  });
});

describe("emptyViewNotice", () => {
  const item = (id: string, status: RoadmapItem["status"]): RoadmapItem => ({
    id,
    area: id.split("-")[0]!,
    status,
    title: id,
    deps: [],
    parent: null,
  });

  it("says a project with no items is empty, not filtered", () => {
    expect(emptyViewNotice([], new Set(["done"]), new Set())).toEqual({ filtered: false });
  });

  it("is silent while anything is shown", () => {
    expect(emptyViewNotice([item("A-1", "done"), item("A-2", "to-do")], new Set(["done"]), new Set())).toBeNull();
  });

  it("counts what each filter hid, an item hidden twice under its status", () => {
    const items = [item("A-1", "done"), item("A-2", "done"), item("B-1", "to-do"), item("B-2", "done")];
    expect(emptyViewNotice(items, new Set(["done"]), new Set(["B"]))).toEqual({
      filtered: true,
      hidden: 4,
      reasons: ["3 done", "1 in hidden areas"],
    });
  });

  it("lists hidden statuses in workflow order, whichever comes first in the plan", () => {
    const items = [item("A-1", "to-do"), item("A-2", "done"), item("A-3", "review")];
    expect(emptyViewNotice(items, new Set(["to-do", "review", "done"]), new Set())).toMatchObject({
      reasons: ["1 done", "1 review", "1 to-do"],
    });
  });
});
