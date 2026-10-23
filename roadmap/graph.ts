import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import { STATUSES, type RoadmapItem, splitScope } from "../scripts/tickets";

export type ColourMode = "status" | "area";

/** Leaf ticket card payload. `colour` is the primary hue (status or area, per mode); `statusColour` always
 *  tracks status so the glyph stays a status signal even in area mode. */
export interface ItemNodeData extends Record<string, unknown> {
  item: RoadmapItem;
  colour: string;
  statusColour: string;
  selected: boolean;
  dimmed: boolean;
  /** This ticket has a dependency edge not drawn at rest (a filtered-out or satisfied cross-group link), so its
   *  handle carries a hint: `In` on the target (left) side, `Out` on the source (right) side. */
  hiddenLinkIn: boolean;
  hiddenLinkOut: boolean;
}
export type ItemNode = Node<ItemNodeData, "item">;

/** A parent ticket rendered as a container box (title bar + its child tickets inside). Selectable like a
 *  leaf (opens its doc block), but also frames its children. */
export interface TicketNodeData extends Record<string, unknown> {
  item: RoadmapItem;
  colour: string;
  statusColour: string;
  count: number;
  selected: boolean;
  dimmed: boolean;
  hiddenLinkIn: boolean;
  hiddenLinkOut: boolean;
}
export type TicketNode = Node<TicketNodeData, "ticket">;

/** An area (epic) container box. */
export interface AreaNodeData extends Record<string, unknown> {
  area: string;
  colour: string;
  count: number;
  /** True for a box holding another project's placeholders, which is styled as absent rather than as an area. */
  foreign?: boolean;
}
export type AreaNode = Node<AreaNodeData, "area">;

/**
 * A dependency that names another project (`PROJ-11`), drawn as a placeholder rather than a real node.
 *
 * The item it names is not in this graph - the viewer renders one project at a time, and the other half of a
 * split plan may not even be loaded - so there is nothing to draw and nothing to select. A placeholder answers
 * the only question the edge raises: where does it go.
 */
export interface GhostNodeData extends Record<string, unknown> {
  project: string;
  ref: string;
  dimmed: boolean;
}
export type GhostNode = Node<GhostNodeData, "ghost">;

export type RoadmapNode = AreaNode | TicketNode | ItemNode | GhostNode;

/** The placeholder's node id, namespaced so it can never collide with a ref in this project. */
export const ghostIdFor = (project: string, ref: string): string => `elsewhere:${project}:${ref}`;

/** The pseudo-area one foreign project's placeholders are boxed in. */
const foreignArea = (project: string): string => `elsewhere:${project}`;

/** Every dependency in this plan that names another project, paired with the item that declares it. */
export function foreignLinks(items: RoadmapItem[]): { ghostId: string; project: string; ref: string; dependent: string }[] {
  return items.flatMap((item) =>
    item.deps.flatMap((dep) => {
      const scope = splitScope(dep);
      return scope === null ? [] : [{ ghostId: ghostIdFor(scope.project, scope.ref), ...scope, dependent: item.id }];
    }),
  );
}

/** A distinct hue per area, assigned by first-seen order (areas are open, so this cycles). */
const AREA_PALETTE = [
  "#4f9dff", // blue
  "#34d399", // green
  "#a884f3", // violet
  "#fbbf24", // amber
  "#f472b6", // pink
  "#22d3ee", // cyan
  "#fb923c", // orange
  "#a3e635", // lime
];

export function areaColours(areas: string[]): Record<string, string> {
  return Object.fromEntries(areas.map((area, index) => [area, AREA_PALETTE[index % AREA_PALETTE.length]!]));
}

const ITEM_WIDTH = 212;
const ITEM_HEIGHT = 62;
const GAP = 34; // horizontal/vertical space between packed cards
const PAD_X = 18; // box inner side padding
const PAD_TOP = 46; // box title bar
const PAD_BOTTOM = 20;
const AREA_GAP = 68; // between area boxes - a wide gutter so cross-area links have room to run
const GHOST_HEIGHT = 34; // a placeholder carries a ref and nothing else, so it needs no room for a title
const GHOST_GAP = 12;
const RANKSEP = 92; // dagre horizontal rank spacing (the flow direction)
const NODESEP = 30; // dagre spacing within a rank

interface Size {
  width: number;
  height: number;
}
interface Placement extends Size {
  x: number;
  y: number;
}
/** One horizontal run of the skyline packer: the filled height `y` across [x, x + width). */
interface Segment {
  x: number;
  y: number;
  width: number;
}

const childrenOf = (items: RoadmapItem[], parentId: string | null): RoadmapItem[] =>
  items.filter((item) => item.parent === parentId);

/** True when one id is an ancestor of the other (dotted nesting, e.g. `AGENT-10` and `AGENT-10.1`). A declared
 *  dependency between a ticket and its own ancestor is already expressed by the nesting, so we don't draw it -
 *  it would render as a box linked to a card sitting inside itself. */
const structuralEdge = (a: string, b: string): boolean => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

/** The rendered size of one item: a leaf card, or (if it has children) the box that frames them. */
function sizeOf(item: RoadmapItem, items: RoadmapItem[]): Size {
  const kids = childrenOf(items, item.id);
  if (kids.length === 0) return { width: ITEM_WIDTH, height: ITEM_HEIGHT };
  const box = layoutSiblings(kids, items).box;
  return { width: box.width, height: box.height };
}

/** A box carrying its own id, the unit both packers work on. */
type Boxed = { id: string } & Size;

/** Lay a connected set of tickets out left-to-right by dependency (dagre), normalised so the content's
 *  top-left sits at (0,0). Returns content-relative placements and the flow's extent. */
function flowLayout(
  nodes: RoadmapItem[],
  edges: ReadonlyArray<readonly [string, string]>,
  sizes: Map<string, Size>,
): { placements: Map<string, Placement>; extent: Size } {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: NODESEP, ranksep: RANKSEP });
  graph.setDefaultEdgeLabel(() => ({}));
  // Pass dagre a fresh label object per node - dagre mutates it with the computed centre, and reusing the
  // `sizes` object would then leak that centre back into our placements.
  for (const node of nodes) {
    const size = sizes.get(node.id)!;
    graph.setNode(node.id, { width: size.width, height: size.height });
  }
  for (const [from, to] of edges) graph.setEdge(from, to);
  dagre.layout(graph);

  const placements = new Map<string, Placement>();
  let minX = Infinity;
  let minY = Infinity;
  for (const node of nodes) {
    const laid = graph.node(node.id);
    const size = sizes.get(node.id)!;
    const x = laid.x - size.width / 2;
    const y = laid.y - size.height / 2;
    placements.set(node.id, { x, y, width: size.width, height: size.height });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  }
  let width = 0;
  let height = 0;
  for (const placement of placements.values()) {
    placement.x -= minX;
    placement.y -= minY;
    width = Math.max(width, placement.x + placement.width);
    height = Math.max(height, placement.y + placement.height);
  }
  return { placements, extent: { width, height } };
}

/** Pack boxes into left-to-right shelves (rows), wrapping to a new shelf when the next box would exceed
 *  `maxRowWidth`. Order is preserved (cards stay in document order), and each shelf is as tall as its tallest
 *  box. Returns content-relative placements (origin 0,0) and the packed extent. */
function shelfPack(
  boxes: Boxed[],
  maxRowWidth: number,
  gap: number,
): { placements: Map<string, Placement>; extent: Size } {
  const placements = new Map<string, Placement>();
  let x = 0;
  let y = 0;
  let shelfHeight = 0;
  let width = 0;
  for (const box of boxes) {
    if (x > 0 && x + box.width > maxRowWidth) {
      y += shelfHeight + gap;
      x = 0;
      shelfHeight = 0;
    }
    placements.set(box.id, { x, y, width: box.width, height: box.height });
    x += box.width + gap;
    width = Math.max(width, x - gap);
    shelfHeight = Math.max(shelfHeight, box.height);
  }
  return { placements, extent: { width, height: y + shelfHeight } };
}

/**
 * Pack boxes into a compact block with a bottom-left skyline heuristic: place each box (tallest first) at the
 * lowest - then leftmost - position where it fits within `maxWidth`. Unlike shelf packing, this backfills the
 * vertical gaps a tall box leaves beside shorter ones, so a set of very differently-sized boxes (the area
 * boxes) packs tight instead of leaving big empty bands under the short ones. Returns content-relative
 * placements (origin 0,0) and the packed extent.
 */
function packBoxes(
  boxes: Boxed[],
  maxWidth: number,
  gap: number,
): { placements: Map<string, Placement>; extent: Size } {
  const width = Math.max(maxWidth, ...boxes.map((box) => box.width)); // never narrower than the widest box
  // The skyline is a left-to-right list of segments; `y` is the filled height across each segment's span.
  let skyline: Segment[] = [{ x: 0, y: 0, width }];
  const placements = new Map<string, Placement>();
  const order = [...boxes].sort((first, second) => second.height - first.height || second.width - first.width);

  for (const box of order) {
    // Rest the box on each segment's left edge (on the highest skyline it would span) and keep the lowest such
    // rest, ties broken leftmost - the classic bottom-left fill.
    let best: { x: number; y: number } | null = null;
    for (const segment of skyline) {
      const x = segment.x;
      if (x + box.width > width) continue; // would overflow the block
      let restY = 0;
      for (const other of skyline) {
        if (other.x + other.width <= x || other.x >= x + box.width) continue; // no horizontal overlap
        restY = Math.max(restY, other.y);
      }
      if (best === null || restY < best.y || (restY === best.y && x < best.x)) best = { x, y: restY };
    }
    const spot = best ?? { x: 0, y: 0 };
    placements.set(box.id, { x: spot.x, y: spot.y, width: box.width, height: box.height });
    skyline = raiseSkyline(skyline, spot.x, box.width + gap, spot.y + box.height + gap);
  }

  let extentWidth = 0;
  let extentHeight = 0;
  for (const placement of placements.values()) {
    extentWidth = Math.max(extentWidth, placement.x + placement.width);
    extentHeight = Math.max(extentHeight, placement.y + placement.height);
  }
  return { placements, extent: { width: extentWidth, height: extentHeight } };
}

/** Raise the skyline over [x, x + width) to height `y`, clipping the segments it covers and merging equal-height
 *  neighbours so the segment list stays minimal. Segments outside the range are untouched. */
function raiseSkyline(skyline: Segment[], x: number, width: number, y: number): Segment[] {
  const end = x + width;
  const kept: Segment[] = [];
  for (const segment of skyline) {
    const segmentEnd = segment.x + segment.width;
    if (segmentEnd <= x || segment.x >= end) {
      kept.push(segment);
      continue;
    }
    if (segment.x < x) kept.push({ x: segment.x, y: segment.y, width: x - segment.x });
    if (segmentEnd > end) kept.push({ x: end, y: segment.y, width: segmentEnd - end });
  }
  kept.push({ x, y, width });
  kept.sort((first, second) => first.x - second.x);
  const merged: Segment[] = [];
  for (const segment of kept) {
    const last = merged[merged.length - 1];
    if (last && last.y === segment.y && last.x + last.width === segment.x) last.width += segment.width;
    else merged.push({ ...segment });
  }
  return merged;
}

/** A row-width budget for shelf-packing `boxes` into a compact, roughly landscape block. Targets total area
 *  rather than a column count, so a set that mixes small cards with a few large boxes packs the cards tightly
 *  and lets each big box take its own shelf (a column count off the widest box would instead inflate every row
 *  to that width). Never narrower than the widest box, so nothing is forced to overflow its row.
 *
 *  `spread` biases the budget wider: it is NOT the resulting aspect ratio but a slack factor for the vertical
 *  space shelf-packing wastes when box heights vary. ~2.8 empirically lands both the area boxes and the whole
 *  map near a 3:2 landscape; raise it for wider/shorter, lower it for taller/narrower. */
function packWidth(boxes: Size[], gap: number, spread = 2.8): number {
  const totalArea = boxes.reduce((sum, box) => sum + (box.width + gap) * (box.height + gap), 0);
  const widest = Math.max(...boxes.map((box) => box.width));
  return Math.max(widest, Math.sqrt(totalArea * spread));
}

/**
 * Lay a set of sibling tickets out relative to a (0,0) content origin, in two zones: siblings joined by
 * dependencies flow left-to-right (dagre), and the dependency-free remainder packs into a compact grid below
 * them. Splitting the two matters because dagre lays disconnected nodes out as separate components and
 * strands them in half-empty ranks - feeding it the loose cards is what made mixed areas sprawl. A group with
 * no dependencies at all is just the grid; a fully-connected group is just the flow. Returns each sibling's
 * placement (top-left, content-relative) and the enclosing box (content extent + container title/side/bottom
 * padding), computed from the actual placements so a box always frames its children.
 */
function layoutSiblings(
  siblings: RoadmapItem[],
  items: RoadmapItem[],
): { placements: Map<string, Placement>; box: Size } {
  const sizes = new Map(siblings.map((sibling) => [sibling.id, sizeOf(sibling, items)]));
  const siblingIds = new Set(siblings.map((sibling) => sibling.id));
  const intraEdges = siblings.flatMap((sibling) =>
    sibling.deps.filter((dep) => siblingIds.has(dep)).map((dep) => [dep, sibling.id] as const),
  );
  const connectedIds = new Set(intraEdges.flat());
  const connected = siblings.filter((sibling) => connectedIds.has(sibling.id));
  const loose = siblings.filter((sibling) => !connectedIds.has(sibling.id));

  const placements = new Map<string, Placement>();

  // Zone A: the dependency-connected siblings, ranked left-to-right so links point forward.
  const flow =
    connected.length > 0
      ? flowLayout(connected, intraEdges, sizes)
      : { placements: new Map<string, Placement>(), extent: { width: 0, height: 0 } };
  for (const [id, placement] of flow.placements) placements.set(id, placement);

  // Zone B: the dependency-free siblings, packed into a compact grid below the flow (or on their own when
  // there is no flow). The grid is at least as wide as the flow so the two zones share a left edge.
  if (loose.length > 0) {
    const looseBoxes: Boxed[] = loose.map((sibling) => ({ id: sibling.id, ...sizes.get(sibling.id)! }));
    const rowWidth = Math.max(flow.extent.width, packWidth(looseBoxes, GAP));
    const packed = shelfPack(looseBoxes, rowWidth, GAP);
    const offsetY = connected.length > 0 ? flow.extent.height + GAP : 0;
    for (const [id, placement] of packed.placements) {
      placements.set(id, { ...placement, y: placement.y + offsetY });
    }
  }

  return { placements, box: boxOf(placements) };
}

/** The box that encloses a set of placed children: their extent plus the container padding (title bar on
 *  top, PAD_X either side, PAD_BOTTOM below). Children are positioned at PAD_X/PAD_TOP + placement, so this
 *  guarantees the frame always contains them. */
function boxOf(placements: Map<string, Placement>): Size {
  let right = 0;
  let bottom = 0;
  for (const placement of placements.values()) {
    right = Math.max(right, placement.x + placement.width);
    bottom = Math.max(bottom, placement.y + placement.height);
  }
  return { width: right + 2 * PAD_X, height: bottom + PAD_TOP + PAD_BOTTOM };
}

/** A built area: its name, its inner nodes (already laid out relative to the box), and the box size. */
interface BuiltArea {
  area: string;
  inner: { nodes: RoadmapNode[]; box: Size };
  size: Size;
  /** The other project this box stands in for, when it holds placeholders rather than items (`PROJ-11`). */
  foreign?: string;
}

/** Order the built areas so a dependency area precedes the areas that depend on it (a post-order over the
 *  cross-area dependency graph, driven by the incoming area order). Packed in sequence, this keeps the few
 *  cross-area links pointing forward (dependency on the left) and adjacent, rather than backwards or spanning
 *  the map. Areas with no cross-area link keep their original order. */
function orderAreasByLinkage(built: BuiltArea[], items: RoadmapItem[]): BuiltArea[] {
  const areaOf = (id: string): string => id.split("-")[0] ?? id;
  // Directed: `dependsOn[area]` is the set of areas whose tickets `area`'s tickets depend on.
  const dependsOn = new Map<string, Set<string>>();
  for (const item of items) {
    for (const dep of item.deps) {
      // A dependency in another project orders by the box its placeholder sits in, so that box lands to the
      // left of everything depending on it like any other dependency. `areaOf` alone would read `apm:DIST-1`
      // as an area called `apm:DIST` - a phantom node in the ordering graph (`PROJ-11`).
      const scope = splitScope(dep);
      const [dependency, dependent] = [scope === null ? areaOf(dep) : foreignArea(scope.project), areaOf(item.id)];
      if (dependency !== dependent) {
        const deps = dependsOn.get(dependent) ?? new Set<string>();
        deps.add(dependency);
        dependsOn.set(dependent, deps);
      }
    }
  }
  const byArea = new Map(built.map((entry) => [entry.area, entry]));
  const seen = new Set<string>();
  const order: BuiltArea[] = [];
  const emit = (area: string): void => {
    const entry = byArea.get(area);
    if (!entry || seen.has(area)) return;
    seen.add(area); // set before recursing so a dependency cycle can't loop forever
    for (const dependency of dependsOn.get(area) ?? []) emit(dependency); // dependency areas first
    order.push(entry);
  };
  for (const entry of built) emit(entry.area);
  return order;
}

/**
 * Build the React Flow graph: one box per area, tickets laid out inside by dependency flow, parent tickets
 * framing their sub-tickets (nested boxes). Area boxes are shelf-packed into a roughly square block (with
 * dependency-linked areas ordered adjacent) so the whole map fits a screen. Dependency edges are drawn at the
 * ticket level and flow forward (dep -> dependent). `colourMode` chooses the item hue; `selectedId` drives the
 * selection glow, neighbour highlight, and dimming.
 *
 * The layout always covers the FULL item set; filtering marks nodes `hidden` (via `hiddenIds`) rather than
 * removing them, so a filter change never re-flows the map - visible nodes keep their exact positions.
 *
 * Edges are built separately (`buildEdges`) so hover/selection restyling updates only the edge layer and
 * never has to rebuild - and repaint - a single node.
 */
export function buildGraph(
  items: RoadmapItem[],
  areas: string[],
  colours: Record<string, string>,
  colourMode: ColourMode,
  selectedId: string | null,
  hiddenIds: Set<string>,
): RoadmapNode[] {
  const visibleIds = new Set(items.map((item) => item.id));
  const depEdges = items.flatMap((item) =>
    item.deps
      .filter((dep) => visibleIds.has(dep) && !structuralEdge(dep, item.id))
      .map((dep) => ({ id: `${dep}->${item.id}`, source: dep, target: item.id })),
  );
  // Dependencies naming another project (`PROJ-11`), grouped by the placeholder they point at. Only links
  // whose *dependent* is on screen count: a placeholder with nothing pointing at it says nothing.
  const dependentsByGhost = new Map<string, string[]>();
  for (const link of foreignLinks(items)) {
    if (!visibleIds.has(link.dependent)) continue;
    dependentsByGhost.set(link.ghostId, [...(dependentsByGhost.get(link.ghostId) ?? []), link.dependent]);
  }
  const ghostEdges = [...dependentsByGhost].flatMap(([ghostId, dependents]) =>
    dependents.map((dependent) => ({ source: ghostId, target: dependent })),
  );

  // Placeholders join the neighbour set, or selecting an item would dim everything except the one edge
  // leaving the graph, which is the opposite of what selection is for.
  const neighbours = selectedId
    ? new Set(
        [...depEdges, ...ghostEdges]
          .filter((edge) => edge.source === selectedId || edge.target === selectedId)
          .flatMap((edge) => [edge.source, edge.target]),
      )
    : null;

  // A ticket carries a "hidden connection" hint on a handle when it has an edge not drawn at rest - because the
  // other end is filtered out (`hiddenIds`), or because it is a satisfied cross-group link (its source is done,
  // hidden to cut clutter and revealed on hover). Left handle = an incoming such edge, right = an outgoing one.
  const areaOf = (id: string): string => id.split("-")[0] ?? id;
  const doneIds = new Set(items.filter((item) => item.status === "done").map((item) => item.id));
  const hiddenLinkIn = new Set<string>();
  const hiddenLinkOut = new Set<string>();
  for (const edge of depEdges) {
    const filteredOut = hiddenIds.has(edge.source) || hiddenIds.has(edge.target);
    const staleHidden = areaOf(edge.source) !== areaOf(edge.target) && doneIds.has(edge.source);
    if (!filteredOut && !staleHidden) continue;
    if (!hiddenIds.has(edge.source)) hiddenLinkOut.add(edge.source);
    if (!hiddenIds.has(edge.target)) hiddenLinkIn.add(edge.target);
  }

  const hueOf = (item: RoadmapItem): string =>
    colourMode === "area" ? (colours[item.area] ?? "#94a3b8") : (STATUSES[item.status]?.colour ?? "#94a3b8");
  const nodeDataFor = (item: RoadmapItem) => ({
    item,
    colour: hueOf(item),
    statusColour: STATUSES[item.status]?.colour ?? "#94a3b8",
    selected: item.id === selectedId,
    dimmed: neighbours ? !neighbours.has(item.id) : false,
    hiddenLinkIn: hiddenLinkIn.has(item.id),
    hiddenLinkOut: hiddenLinkOut.has(item.id),
  });

  // Lay a container's children out once and emit their nodes (positions relative to the container). A child
  // that has children of its own becomes a nested ticket-box and recurses. `parentId` (without `extent`)
  // keeps children moving with their box when it is dragged, but doesn't clamp the auto-layout into overlap.
  const buildContainer = (containerId: string, siblings: RoadmapItem[]): { nodes: RoadmapNode[]; box: Size } => {
    const { placements, box } = layoutSiblings(siblings, items);
    const nodes = siblings.flatMap((sibling): RoadmapNode[] => {
      const placement = placements.get(sibling.id)!;
      const position = { x: PAD_X + placement.x, y: PAD_TOP + placement.y };
      const kids = childrenOf(items, sibling.id);
      if (kids.length > 0) {
        const inner = buildContainer(sibling.id, kids);
        const ticketBox: TicketNode = {
          id: sibling.id,
          type: "ticket",
          parentId: containerId,
          position,
          hidden: hiddenIds.has(sibling.id),
          style: { width: inner.box.width, height: inner.box.height },
          data: { ...nodeDataFor(sibling), count: kids.length },
          zIndex: 1,
        };
        return [ticketBox, ...inner.nodes];
      }
      const leaf: ItemNode = {
        id: sibling.id,
        type: "item",
        parentId: containerId,
        position,
        hidden: hiddenIds.has(sibling.id),
        style: { width: ITEM_WIDTH, height: ITEM_HEIGHT },
        data: nodeDataFor(sibling),
        // z 3 (area box 0, nested ticket box 1, leaf card 3) leaves room for edges to resolve to effective z 2:
        // above nested boxes so a link reaches a node inside one, still below leaf cards so it never occludes one.
        zIndex: 3,
      };
      return [leaf];
    });
    return { nodes, box };
  };

  // Build each area's inner layout once, then pack the area boxes with the skyline packer so short areas
  // backfill the vertical gaps beside the tall ones (the areas vary a lot in height), keeping the map compact.
  const built: BuiltArea[] = areas.flatMap((area) => {
    const topTickets = items.filter((item) => item.area === area && item.parent === null);
    if (topTickets.length === 0) return [];
    const inner = buildContainer(`area:${area}`, topTickets);
    return [{ area, inner, size: inner.box }];
  });

  // One box per foreign project, holding a placeholder for each of its refs this plan points at. A box rather
  // than a node beside each dependent: the layout places boxes and has nowhere to put a loose node, and
  // grouping by project is also what makes the picture readable - "these four come from apm-cloud".
  const ghostAreas: BuiltArea[] = [...new Set([...dependentsByGhost.keys()].map((id) => id.split(":")[1]!))]
    .sort()
    .map((project) => {
      const refs = [...dependentsByGhost.keys()]
        .filter((id) => id.startsWith(`elsewhere:${project}:`))
        .map((id) => id.slice(`elsewhere:${project}:`.length))
        .sort();
      const nodes: RoadmapNode[] = refs.map((ref, index) => {
        const ghostId = ghostIdFor(project, ref);
        return {
          id: ghostId,
          type: "ghost",
          parentId: `area:${foreignArea(project)}`,
          position: { x: PAD_X, y: PAD_TOP + index * (GHOST_HEIGHT + GHOST_GAP) },
          // Hidden with the last item that referenced it, matching the rule for an area box.
          hidden: (dependentsByGhost.get(ghostId) ?? []).every((id) => hiddenIds.has(id)),
          data: { project, ref, dimmed: neighbours ? !neighbours.has(ghostId) : false },
          style: { width: ITEM_WIDTH, height: GHOST_HEIGHT },
          zIndex: 3,
        } satisfies GhostNode;
      });
      const size = {
        width: ITEM_WIDTH + PAD_X * 2,
        height: PAD_TOP + refs.length * GHOST_HEIGHT + (refs.length - 1) * GHOST_GAP + PAD_BOTTOM,
      };
      return { area: foreignArea(project), foreign: project, inner: { nodes, box: size }, size };
    });

  const ordered = orderAreasByLinkage([...ghostAreas, ...built], items);
  const packed = packBoxes(
    ordered.map((entry) => ({ id: entry.area, ...entry.size })),
    // Skyline packing backfills the gaps shelf packing left, so it needs far less width slack: ~1.6 lands the
    // densest, roughly-landscape block (empirically ~88% filled).
    packWidth(
      ordered.map((entry) => entry.size),
      AREA_GAP,
      1.6,
    ),
    AREA_GAP,
  );

  const nodes: RoadmapNode[] = ordered.flatMap((entry) => {
    const position = packed.placements.get(entry.area)!;
    if (entry.foreign !== undefined) {
      const foreignBox: AreaNode = {
        id: `area:${entry.area}`,
        type: "area",
        position: { x: position.x, y: position.y },
        hidden: entry.inner.nodes.every((node) => node.hidden === true),
        // The project's own name as the title, so the box reads as "these live in apm-cloud".
        data: { area: entry.foreign, colour: "#64748b", count: entry.inner.nodes.length, foreign: true },
        style: { width: entry.size.width, height: entry.size.height },
        zIndex: 0,
      };
      return [foreignBox, ...entry.inner.nodes];
    }
    const areaItems = items.filter((item) => item.area === entry.area);
    const areaBox: AreaNode = {
      id: `area:${entry.area}`,
      type: "area",
      position: { x: position.x, y: position.y },
      hidden: areaItems.every((item) => hiddenIds.has(item.id)), // hide the box only when nothing in it shows
      data: { area: entry.area, colour: colours[entry.area] ?? "#94a3b8", count: areaItems.length },
      style: { width: entry.size.width, height: entry.size.height },
      zIndex: 0,
    };
    return [areaBox, ...entry.inner.nodes];
  });

  return nodes;
}

/**
 * Build the dependency edges as a layer independent of the node layout, so hover and selection restyle them
 * (via `setEdges` alone) without rebuilding - or repainting - a single node.
 *
 * Every edge sits at z-index -1, which resolves to effective z 2 (React Flow adds the endpoint cards' z of 3):
 * above the area-box backgrounds (z 0) and nested ticket boxes (z 1) - so the line stays visible in the gaps
 * and reaches a node sitting inside a nested box - but below every leaf card (z 3) so it never occludes a
 * ticket. A cross-area edge is additionally de-emphasised - thinner, fainter,
 * and dashed (so it reads at a glance as a link that does not apply inside the group) - since it cannot route
 * cleanly between separate boxes. An edge is "lit" (full colour) when selected,
 * when either of its endpoint tickets is hovered, or when the edge itself is hovered - so a connection surfaces
 * from its own nodes or line, not from the surrounding box. Selecting also dims the edges it does not touch;
 * hovering only brightens, to stay calm. (Lit edges stay behind the cards too - they brighten in place.)
 *
 * A satisfied cross-group link - one that crosses groups and whose source is already `done` - is hidden at rest
 * (its dependency is met, so it is just clutter) and revealed only when lit. The endpoints still flag it with a
 * handle hint (see `buildGraph`), so you can tell there is something to hover for.
 */
export function buildEdges(
  items: RoadmapItem[],
  colours: Record<string, string>,
  colourMode: ColourMode,
  selectedId: string | null,
  hoveredId: string | null,
  hoveredEdgeId: string | null,
  hiddenIds: Set<string>,
): Edge[] {
  const visibleIds = new Set(items.map((item) => item.id));
  const doneIds = new Set(items.filter((item) => item.status === "done").map((item) => item.id));
  const areaOf = (id: string): string => id.split("-")[0] ?? id;
  const hueOf = (item: RoadmapItem): string =>
    colourMode === "area" ? (colours[item.area] ?? "#94a3b8") : (STATUSES[item.status]?.colour ?? "#94a3b8");

  // An edge to another project's placeholder (`PROJ-11`). Dashed like any cross-group link, and **never
  // hidden as satisfied**: this graph has no idea whether the other project's item is done, and hiding it
  // would be a claim we cannot make. Muted rather than area-coloured, since it belongs to no area here.
  const ghostEdges: Edge[] = foreignLinks(items)
    .filter((link) => visibleIds.has(link.dependent))
    .map((link) => {
      const id = `${link.ghostId}->${link.dependent}`;
      const selectedEnd = selectedId === link.ghostId || selectedId === link.dependent;
      const hoveredEnd = hoveredId != null && (link.ghostId === hoveredId || link.dependent === hoveredId);
      const lit = selectedEnd || hoveredEnd || id === hoveredEdgeId;
      const filteredHidden = hiddenIds.has(link.dependent);
      return {
        id,
        source: link.ghostId,
        target: link.dependent,
        type: "smoothstep",
        pathOptions: { borderRadius: 12 },
        hidden: filteredHidden && !hoveredEnd,
        animated: selectedEnd,
        zIndex: -1,
        style: {
          stroke: lit ? "#cbd5e1" : "#7c8aa0",
          strokeWidth: lit ? 2.5 : 1.2,
          strokeDasharray: "6 5",
          opacity: lit ? 1 : selectedId ? 0.08 : 0.4,
        },
      };
    });

  const withinPlan = items.flatMap((item) =>
    item.deps
      .filter((dep) => visibleIds.has(dep) && !structuralEdge(dep, item.id))
      .map((dep) => {
        const id = `${dep}->${item.id}`;
        const selectedEnd = selectedId === dep || selectedId === item.id;
        const hoveredEnd = hoveredId != null && (dep === hoveredId || item.id === hoveredId);
        const crossArea = areaOf(dep) !== areaOf(item.id);
        const lit = selectedEnd || hoveredEnd || id === hoveredEdgeId;
        const staleHidden = crossArea && doneIds.has(dep); // satisfied cross-group link: hide until lit
        const filteredHidden = hiddenIds.has(dep) || hiddenIds.has(item.id);
        // Hovering a filtered-out node's still-visible neighbour previews the hidden node as a ghost (App), so
        // reveal its edge too.
        const ghostRevealed = hoveredEnd && filteredHidden;
        return {
          id,
          source: dep,
          target: item.id,
          type: "smoothstep",
          pathOptions: { borderRadius: 12 },
          hidden: (filteredHidden && !ghostRevealed) || (staleHidden && !lit),
          animated: selectedEnd,
          zIndex: -1, // -> effective z 2: above box backgrounds (0) and nested boxes (1), below leaf cards (3)
          style: {
            stroke: lit ? hueOf(item) : "#7c8aa0",
            strokeWidth: lit ? 2.5 : crossArea ? 1.2 : 1.5,
            strokeDasharray: crossArea ? "6 5" : undefined, // dashed: reads at a glance as a cross-group link
            opacity: lit ? 1 : selectedId ? (crossArea ? 0.08 : 0.12) : crossArea ? 0.4 : 0.6,
          },
        };
      }),
  );

  return [...withinPlan, ...ghostEdges];
}
