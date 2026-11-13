import { areasOf, type RoadmapItem } from "../scripts/tickets";
import { buildGraph, memoryOf, type LayoutMemory, type RoadmapNode } from "./graph";

/**
 * How stable a layout is from one version of a plan to the next (`VIEW-23.1`).
 *
 * The criterion is `VIEW-23`'s **orthogonal ordering**: if A was left of B it should stay left of B, and if A
 * was above B it should stay above. That is what lets someone find a ticket by what it sits next to, and it is
 * what the eye actually notices - a whole map sliding along by forty pixels reads as nothing, two neighbours
 * swapping sides reads as "it moved". So the headline number is the share of pairs whose order flipped, and
 * displacement is only reported beside it.
 *
 * **A node's place is its top-left corner, not its centre.** A box grows rightwards and downwards as items are
 * added to it, which moves its centre while its title - what you actually look for - stays put. Measured by
 * centre, a growing area would count as having moved past whatever sits below it, which is not what anyone
 * sees. The layout's own never-reorder rule (`arrange`, in `graph.ts`) is stated on the same corner.
 *
 * Pure and Node-free, like `graph.ts`, so the same measurement runs in a unit test, in the history replay
 * (`scripts/layoutHistory.ts`) and, if it is ever wanted, in the browser.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every node's rectangle in map coordinates. React Flow positions a child relative to its parent, so the
 *  absolute position is the sum along the `parentId` chain. */
export function absoluteRects(nodes: RoadmapNode[]): Map<string, Rect> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rects = new Map<string, Rect>();
  const resolve = (node: RoadmapNode): Rect => {
    const known = rects.get(node.id);
    if (known) return known;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const origin = parent ? resolve(parent) : { x: 0, y: 0 };
    const rect = {
      x: origin.x + node.position.x,
      y: origin.y + node.position.y,
      width: Number(node.style?.width ?? 0),
      height: Number(node.style?.height ?? 0),
    };
    rects.set(node.id, rect);
    return rect;
  };
  for (const node of nodes) resolve(node);
  return rects;
}

export interface Stability {
  /** Pairs present in both layouts. */
  pairs: number;
  /** Pairs whose left/right or above/below order reversed. */
  flips: number;
  /** Mean distance, in pixels, that a node present in both layouts moved. */
  meanDisplacement: number;
}

/**
 * Compare two layouts over the ids both contain. A pair flips on an axis when its corners are strictly
 * ordered one way before and strictly the other way after; a pair that was level and no longer is (or the
 * reverse) is not a flip, since nothing changed sides.
 */
export function compareLayouts(before: Map<string, Rect>, after: Map<string, Rect>, ids: string[]): Stability {
  const shared = ids.filter((id) => before.has(id) && after.has(id));
  const was = shared.map((id) => before.get(id)!);
  const now = shared.map((id) => after.get(id)!);
  let flips = 0;
  for (let a = 0; a < shared.length; a++) {
    for (let b = a + 1; b < shared.length; b++) {
      const flippedX = (was[a]!.x - was[b]!.x) * (now[a]!.x - now[b]!.x) < 0;
      const flippedY = (was[a]!.y - was[b]!.y) * (now[a]!.y - now[b]!.y) < 0;
      if (flippedX || flippedY) flips++;
    }
  }
  const moved = shared.reduce((sum, _id, index) => sum + Math.hypot(now[index]!.x - was[index]!.x, now[index]!.y - was[index]!.y), 0);
  return {
    pairs: (shared.length * (shared.length - 1)) / 2,
    flips,
    meanDisplacement: shared.length === 0 ? 0 : moved / shared.length,
  };
}

/** The two populations worth measuring separately: area boxes against each other (where an area lives on the
 *  map) and items against each other (where a ticket lives). An item compared with an area box is neither. */
export function nodeKinds(nodes: RoadmapNode[]): { areas: string[]; items: string[] } {
  return {
    areas: nodes.filter((node) => node.type === "area").map((node) => node.id),
    items: nodes.filter((node) => node.type === "item" || node.type === "ticket").map((node) => node.id),
  };
}

/** A layout as the measurement sees it: every node's rectangle in map coordinates, and which ids to compare. */
export interface Frame {
  rects: Map<string, Rect>;
  areas: string[];
  items: string[];
}

export const frameOf = (nodes: RoadmapNode[]): Frame => ({ rects: absoluteRects(nodes), ...nodeKinds(nodes) });

/** The layout with nothing remembered: a pure function of the items, as a first open or a reset shows it. */
export const freshLayout = (items: RoadmapItem[]): Frame =>
  frameOf(buildGraph(items, areasOf(items), {}, "area", null, new Set()));

/** The layout carrying its memory forward (`VIEW-23.1`), as the viewer runs it: lay out from what was
 *  remembered, then remember the result for next time. */
export function rememberedLayout(items: RoadmapItem[], memory: LayoutMemory): { frame: Frame; memory: LayoutMemory } {
  const nodes = buildGraph(items, areasOf(items), {}, "area", null, new Set(), memory);
  return { frame: frameOf(nodes), memory: memoryOf(nodes) };
}

/** Lay out each version in turn, both ways, and measure every step: the comparison `VIEW-23.1` is judged by. */
export function replay(versions: RoadmapItem[][]): Record<"fresh" | "remembered", { areas: Summary; items: Summary }> {
  const measure = (frames: Frame[]) => {
    const steps = frames.slice(1).map((frame, index) => ({ before: frames[index]!, after: frame }));
    return {
      areas: summarise(steps.map(({ before, after }) => compareLayouts(before.rects, after.rects, after.areas))),
      items: summarise(steps.map(({ before, after }) => compareLayouts(before.rects, after.rects, after.items))),
    };
  };
  let memory: LayoutMemory = {};
  const remembered = versions.map((items) => {
    const next = rememberedLayout(items, memory);
    memory = next.memory;
    return next.frame;
  });
  return { fresh: measure(versions.map(freshLayout)), remembered: measure(remembered) };
}

export interface Summary {
  steps: number;
  /** Steps where at least one pair flipped. */
  churned: number;
  flips: number;
  pairs: number;
  worst: number;
  meanDisplacement: number;
}

export function summarise(results: Stability[]): Summary {
  const flips = results.reduce((sum, result) => sum + result.flips, 0);
  const pairs = results.reduce((sum, result) => sum + result.pairs, 0);
  return {
    steps: results.length,
    churned: results.filter((result) => result.flips > 0).length,
    flips,
    pairs,
    worst: Math.max(0, ...results.map((result) => (result.pairs === 0 ? 0 : result.flips / result.pairs))),
    meanDisplacement: results.length === 0 ? 0 : results.reduce((sum, result) => sum + result.meanDisplacement, 0) / results.length,
  };
}

const pct = (part: number, whole: number): string => (whole === 0 ? "0%" : `${((100 * part) / whole).toFixed(2)}%`);

export const describe = (label: string, summary: Summary): string =>
  `${label}: ${pct(summary.flips, summary.pairs)} of pairs flipped overall, worst step ${pct(summary.worst, 1)}; ` +
  `${summary.churned} of ${summary.steps} steps reordered something; mean move ${summary.meanDisplacement.toFixed(0)}px`;
