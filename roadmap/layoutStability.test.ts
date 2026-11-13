import { describe, expect, it } from "vitest";
import { areasOf, type RoadmapItem } from "../scripts/tickets";
import { buildGraph, memoryOf, type LayoutMemory, type RoadmapNode } from "./graph";
import { absoluteRects, compareLayouts, rememberedLayout, replay, type Frame, type Rect } from "./layoutStability";

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

/**
 * A plan that grows the way real ones do, seeded so it is the same every run: items arrive in bursts in a few
 * areas, new areas appear now and then, some items nest under earlier ones, and some depend on earlier ones.
 * Synthetic because CI's checkout is shallow, so the real history (`layout:history`) is not available here.
 */
function growingPlan(seed: number, steps: number): RoadmapItem[][] {
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(list: T[]): T => list[Math.floor(random() * list.length)]!;
  const items: RoadmapItem[] = [];
  const counters = new Map<string, number>();
  const areaNames = ["CORE", "DATA", "VIEW", "OPS", "MCP", "DOCS", "PLAT", "LEARN", "CAL", "SCHED"];
  const areas = areaNames.slice(0, 3);
  const versions: RoadmapItem[][] = [];
  for (let step = 0; step < steps; step++) {
    if (random() < 0.08 && areas.length < areaNames.length) areas.push(areaNames[areas.length]!);
    const area = pick(areas);
    for (let burst = 1 + Math.floor(random() * 3); burst > 0; burst--) {
      const inArea = items.filter((item) => item.area === area);
      const parent = inArea.length > 0 && random() < 0.25 ? pick(inArea) : null;
      let id: string;
      if (parent) {
        const children = items.filter((item) => item.parent === parent.id).length;
        id = `${parent.id}.${children + 1}`;
      } else {
        const next = (counters.get(area) ?? 0) + 1;
        counters.set(area, next);
        id = `${area}-${next}`;
      }
      const siblings = items.filter((item) => item.parent === (parent?.id ?? null) && item.area === area);
      const deps = siblings.length > 0 && random() < 0.4 ? [pick(siblings).id] : [];
      items.push({ id, area, status: "to-do", title: id, deps, parent: parent?.id ?? null });
    }
    // Items arrive ordered by (area, sort_path), as the export writes them.
    const ordered = [...items].sort((a, b) => a.area.localeCompare(b.area) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    versions.push(ordered);
  }
  return versions;
}

describe("the layout with a memory (VIEW-23.1)", () => {
  const versions = growingPlan(7, 60);

  it("never reorders two areas, however the plan grows", () => {
    const { remembered } = replay(versions);
    expect(remembered.areas.flips).toBe(0);
  });

  // The invariant is per container: a box pushed along carries its contents with it, which can carry them past
  // an item in a neighbouring box. Rare on a real plan (0.06% of item pairs over this repo's history), and the
  // price of arranging box by box, which is also what keeps a box's interior undisturbed when it moves.
  it("never reorders two items in the same box", () => {
    let memory: LayoutMemory = {};
    let previous: Frame | null = null;
    let flips = 0;
    for (const items of versions) {
      const next = rememberedLayout(items, memory);
      if (previous) {
        const containers = new Set(items.map((item) => item.parent ?? `area:${item.area}`));
        for (const container of containers) {
          const inside = items.filter((item) => (item.parent ?? `area:${item.area}`) === container).map((item) => item.id);
          flips += compareLayouts(previous.rects, next.frame.rects, inside).flips;
        }
      }
      memory = next.memory;
      previous = next.frame;
    }
    expect(flips).toBe(0);
  });

  it("is already settled: laying out its own result again moves nothing", () => {
    const items = versions[versions.length - 1]!;
    let memory: LayoutMemory = {};
    for (const version of versions) memory = rememberedLayout(version, memory).memory;
    expect(rememberedLayout(items, memory).memory).toEqual(memory);
  });

  it("never overlaps two siblings", () => {
    let memory: LayoutMemory = {};
    for (const items of versions) {
      const nodes = buildGraph(items, areasOf(items), {}, "area", null, new Set(), memory);
      memory = memoryOf(nodes);
      const byParent = new Map<string, RoadmapNode[]>();
      // An area's overview lies over its cards on purpose (VIEW-52): it is a layer, not a sibling with a place.
      for (const node of nodes.filter((candidate) => candidate.type !== "overview"))
        byParent.set(node.parentId ?? "", [...(byParent.get(node.parentId ?? "") ?? []), node]);
      for (const siblings of byParent.values()) {
        for (let a = 0; a < siblings.length; a++) {
          for (let b = a + 1; b < siblings.length; b++) {
            const [one, two] = [siblings[a]!, siblings[b]!];
            const [w1, h1, w2, h2] = [one.style!.width, one.style!.height, two.style!.width, two.style!.height].map(Number) as [number, number, number, number];
            const apart =
              one.position.x + w1 <= two.position.x || two.position.x + w2 <= one.position.x ||
              one.position.y + h1 <= two.position.y || two.position.y + h2 <= one.position.y;
            expect(apart, `${one.id} overlaps ${two.id}`).toBe(true);
          }
        }
      }
    }
  });

  it("is far steadier than laying each version out afresh", () => {
    const { fresh, remembered } = replay(versions);
    expect(remembered.items.flips).toBeLessThan(fresh.items.flips / 20);
  });
});
