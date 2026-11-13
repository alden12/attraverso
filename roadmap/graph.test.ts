import { describe, expect, it } from "vitest";
import type { RoadmapItem } from "../scripts/tickets";
import { areaColours, buildGraph, titleLines } from "./graph";

const item = (id: string, deps: string[] = []): RoadmapItem => {
  const parent = id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : null;
  return { id, area: id.split("-")[0]!, status: "to-do", title: id, deps, parent };
};

describe("what a selection dims (VIEW-35)", () => {
  // VIEW-1 frames VIEW-1.1 (no dependencies at all) and VIEW-1.2; VIEW-2.1 depends on VIEW-1.2.
  const items = [item("VIEW-1"), item("VIEW-1.1"), item("VIEW-1.2"), item("VIEW-2"), item("VIEW-2.1", ["VIEW-1.2"]), item("VIEW-3")];
  const dimmed = (selected: string) =>
    Object.fromEntries(
      buildGraph(items, ["VIEW"], {}, "area", selected, new Set())
        .filter((node) => node.type === "item" || node.type === "ticket")
        .map((node) => [node.id, (node.data as { dimmed: boolean }).dimmed]),
    );

  it("never dims the selection, even one with no dependencies to light it", () => {
    expect(dimmed("VIEW-1.1")["VIEW-1.1"]).toBe(false);
  });

  it("never dims a box holding the selection or one of its neighbours", () => {
    const result = dimmed("VIEW-1.2");
    expect(result).toMatchObject({ "VIEW-1": false, "VIEW-1.2": false, "VIEW-2": false, "VIEW-2.1": false });
  });

  it("still dims what the selection has nothing to do with", () => {
    const result = dimmed("VIEW-1.2");
    expect(result).toMatchObject({ "VIEW-1.1": true, "VIEW-3": true });
  });
});

describe("card height follows the title (VIEW-43)", () => {
  it("gives a long title more lines, up to three", () => {
    expect(titleLines("Short")).toBe(1);
    expect(titleLines("Selecting an item greys out the box it sits in, and the items inside with it")).toBe(3);
    expect(titleLines("word ".repeat(80))).toBe(3);
  });

  it("makes the card tall enough for the lines it estimated", () => {
    const short = buildGraph([item("VIEW-1")], ["VIEW"], {}, "area", null, new Set()).find((node) => node.id === "VIEW-1")!;
    const long = buildGraph(
      [{ ...item("VIEW-1"), title: "Selecting an item greys out the box it sits in, and the items inside with it" }],
      ["VIEW"], {}, "area", null, new Set(),
    ).find((node) => node.id === "VIEW-1")!;
    expect(Number(long.style!.height)).toBeGreaterThan(Number(short.style!.height));
  });
});

describe("area colours (VIEW-36, VIEW-51)", () => {
  const many = ["VIEW", "MCP", "DATA", "PLAT", "PROJ", "CTX", "IMP", "OPS", "SCHED", "METRIC", "CAL", "DIST", "MEDIA", "LEARN"];

  it("gives every area its own colour while the palette lasts", () => {
    const ten = areaColours(many.slice(0, 10), many);
    expect(new Set(Object.values(ten)).size).toBe(10);
    // And past ten, the lighter ring, still all different.
    expect(new Set(Object.values(areaColours(many, many))).size).toBe(many.length);
  });

  it("never recolours an older area when a newer one arrives", () => {
    const before = areaColours(many.slice(0, 6), many);
    const after = areaColours(many, many);
    for (const area of many.slice(0, 6)) expect(after[area]).toBe(before[area]);
  });

  it("is the same answer whatever order the areas are listed in, given the same age order", () => {
    expect(areaColours([...many].reverse(), many)).toEqual(areaColours(many, many));
  });

  it("lets an older area keep a colour a newer one also wanted", () => {
    // Two keys that hash to the same preferred colour: whichever is older keeps it.
    const pair = findClash();
    const olderFirst = areaColours(pair, pair);
    const newerFirst = areaColours(pair, [...pair].reverse());
    expect(olderFirst[pair[0]!]).toBe(newerFirst[pair[1]!]);
    expect(olderFirst[pair[0]!]).not.toBe(olderFirst[pair[1]!]);
  });
});

/** Two keys whose preferred colours are the same: alone, each gets its preferred one. */
function findClash(): [string, string] {
  const alone = (key: string) => areaColours([key])[key];
  const seen = new Map<string, string>();
  for (let index = 0; ; index++) {
    const key = `A${index}`;
    const colour = alone(key)!;
    const other = seen.get(colour);
    if (other !== undefined) return [other, key];
    seen.set(colour, key);
  }
}
