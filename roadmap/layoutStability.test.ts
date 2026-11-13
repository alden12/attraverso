import { describe, expect, it } from "vitest";
import { absoluteRects, compareLayouts, type Rect } from "./layoutStability";
import type { RoadmapNode } from "./graph";

const rects = (entries: Record<string, [number, number]>): Map<string, Rect> =>
  new Map(Object.entries(entries).map(([id, [x, y]]) => [id, { x, y, width: 10, height: 10 }]));

describe("compareLayouts (VIEW-23.1)", () => {
  it("counts nothing when the whole map slides, because no pair changed sides", () => {
    const before = rects({ A: [0, 0], B: [100, 0], C: [0, 100] });
    const after = rects({ A: [500, 300], B: [600, 300], C: [500, 400] });
    const result = compareLayouts(before, after, ["A", "B", "C"]);
    expect(result.flips).toBe(0);
    expect(result.pairs).toBe(3);
    expect(result.meanDisplacement).toBeCloseTo(Math.hypot(500, 300));
  });

  it("counts a pair that swapped left and right, and one that swapped above and below", () => {
    const before = rects({ A: [0, 0], B: [100, 0], C: [0, 100] });
    const after = rects({ A: [100, 0], B: [0, 0], C: [0, -100] });
    // A/B swapped sides; C went from below both to above both.
    expect(compareLayouts(before, after, ["A", "B", "C"]).flips).toBe(3);
  });

  it("does not count a pair that was level and is no longer, since nothing changed sides", () => {
    const before = rects({ A: [0, 0], B: [100, 0] });
    const after = rects({ A: [0, 0], B: [100, 50] });
    expect(compareLayouts(before, after, ["A", "B"]).flips).toBe(0);
  });

  it("compares only the ids present in both layouts, so an added or removed node is not a flip", () => {
    const before = rects({ A: [0, 0], B: [100, 0], GONE: [50, 50] });
    const after = rects({ A: [0, 0], B: [100, 0], NEW: [-50, -50] });
    expect(compareLayouts(before, after, ["A", "B", "GONE", "NEW"])).toMatchObject({ pairs: 1, flips: 0 });
  });
});

describe("absoluteRects", () => {
  it("adds each parent's position, since React Flow places a child relative to its parent", () => {
    const node = (id: string, x: number, y: number, parentId?: string) =>
      ({ id, type: "item", position: { x, y }, parentId, style: { width: 5, height: 5 }, data: {} }) as unknown as RoadmapNode;
    const result = absoluteRects([node("leaf", 3, 4, "box"), node("box", 10, 20, "area"), node("area", 100, 200)]);
    expect(result.get("leaf")).toEqual({ x: 113, y: 224, width: 5, height: 5 });
  });
});
