import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  applyNodeChanges,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type NodeChange,
  type XYPosition,
  type Edge,
} from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import { Attachments } from "./Attachments";
import { Metrics } from "./Metrics";
import remarkGfm from "remark-gfm";
// The plan is fetched at runtime and handed in by `main.tsx` (VIEW-11), so this component renders whichever
// store was served to it rather than one baked into the bundle, and whichever project of it the URL asked
// for (VIEW-4).
import type { Plan, Selection } from "./store";
import { useExtensions } from "./extensions";
import { areasOf, STATUSES, type Status, splitScope } from "../scripts/tickets";
import { areaColours, buildGraph, buildEdges, type ColourMode, type RoadmapNode } from "./graph";
import { ItemNodeView } from "./ItemNode";
import { AreaGroupNode } from "./AreaGroupNode";
import { TicketGroupNode } from "./TicketGroupNode";
import { GhostNodeView } from "./GhostNode";
import { loadPositions, savePositions, loadSizes, saveSizes, clearLayout, type BoxSize } from "./positions";
import { LockContext } from "./lockContext";
import { StatusPicker } from "./StatusPicker";
import type { RoadmapItem } from "../scripts/tickets";

const nodeTypes = { item: ItemNodeView, area: AreaGroupNode, ticket: TicketGroupNode, ghost: GhostNodeView };
const STATUS_KEYS = Object.keys(STATUSES) as Status[];
const COLOUR_MODES: ColourMode[] = ["status", "area"];
const GRID = 20; // drag/resize snap grid, aligned to the background dots
/** Shared so `Attachments` sees the same reference between renders: a fresh `[]` each time would retrigger
 *  the effect that resets the panel, clearing an upload the instant it succeeded. */
const EMPTY: never[] = [];

/** With no project selected the toolbar still renders (that is where the switcher lives) over an empty graph.
 *  A module-level constant, so the memos below see a stable reference rather than a new array each render. */
const NO_ITEMS: RoadmapItem[] = [];
const NO_REFS: string[] = [];

/** A planned date (`CAL-1`) as a reader says it, "Mon 2 Nov 2026". Formatted in UTC because the date is a day,
 *  not an instant: in local time, midnight UTC is still the previous evening for anyone west of Greenwich. */
const fmtDay = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function App({ plan, selection, reload }: { plan: Plan; selection: Selection; reload: () => void }) {
  const project = selection.project;
  const { ToolbarActions, EmptyPlan } = useExtensions();
  // Manual layout is stored per project, since a node id is a ticket ref and those repeat across projects.
  const scope = project?.key ?? "";
  const items = project?.items ?? NO_ITEMS; // fetched once and held in state above, so the reference is stable
  const areas = useMemo(() => areasOf(items), [items]);
  const colours = useMemo(() => areaColours(areas), [areas]);

  const [hiddenAreas, setHiddenAreas] = useState<Set<string>>(new Set());
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<Status>>(new Set());
  const [colourMode, setColourMode] = useState<ColourMode>("area");
  const [locked, setLocked] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null); // a ticket with a dependency path, hovered
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null); // a dependency edge, hovered directly
  const [layoutNonce, setLayoutNonce] = useState(0); // bump to force a fresh auto-layout (e.g. after reset)
  // The agreed order (PROJ-8), open on load. It was collapsed at first, on the argument that the graph is
  // what this surface is for - but that hides the one thing the panel exists to answer behind knowing it is
  // there, from exactly the person most likely not to: someone opening this after three weeks away. The chip
  // still closes it, and a graph you have to pan slightly is a smaller cost than an answer nobody finds.
  const [nextOpen, setNextOpen] = useState(true);
  // Which detail-pane sections are collapsed. Held here rather than in each section, so the choice survives
  // the pane unmounting - which happens on every item click - and open is the default (see `Section`).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const sectionProps = (name: string) => ({
    open: !collapsed.has(name),
    onToggle: () => setCollapsed((set) => toggle(set, name)),
  });

  /**
   * The agreed order (`PROJ-8`), resolved to items so the panel can show a title and an area colour.
   *
   * `asPlan` has already dropped done and soft-deleted refs, so the filtering rule lives in one place and the
   * viewer renders what it is handed. Anything still unresolvable is a store that moved under the page.
   */
  const next = useMemo(
    () => (project?.next ?? NO_REFS).flatMap((ref) => items.find((item) => item.id === ref) ?? []),
    [project, items],
  );

  // Ticket ids that touch a dependency path. Only these arm hover highlighting, so hovering a dependency-free
  // card (or an area box) never restyles the edges for nothing - a link surfaces from its own tickets or line.
  const linkedNodes = useMemo(() => {
    const linked = new Set<string>();
    for (const item of items) {
      for (const dep of item.deps) linked.add(dep).add(item.id);
    }
    return linked;
  }, [items]);

  const visibleItems = useMemo(
    () => items.filter((item) => !hiddenAreas.has(item.area) && !hiddenStatuses.has(item.status)),
    [items, hiddenAreas, hiddenStatuses],
  );

  // Which node ids the filters hide. A leaf hides on its own area/status; a container (parent ticket or
  // area box) hides only when everything inside it is hidden, so filtering never orphans a visible child.
  const hiddenIds = useMemo(() => {
    const childrenByParent = new Map<string, RoadmapItem[]>();
    for (const item of items) {
      if (!item.parent) continue;
      const siblings = childrenByParent.get(item.parent);
      if (siblings) siblings.push(item);
      else childrenByParent.set(item.parent, [item]);
    }
    const directlyHidden = (item: RoadmapItem) => hiddenAreas.has(item.area) || hiddenStatuses.has(item.status);
    const memo = new Map<string, boolean>();
    const isHidden = (item: RoadmapItem): boolean => {
      const cached = memo.get(item.id);
      if (cached !== undefined) return cached;
      const children = childrenByParent.get(item.id);
      const hidden = children ? children.every(isHidden) : directlyHidden(item);
      memo.set(item.id, hidden);
      return hidden;
    };
    const hidden = new Set<string>();
    for (const item of items) if (isHidden(item)) hidden.add(item.id);
    return hidden;
  }, [items, hiddenAreas, hiddenStatuses]);

  // For each visible ticket, the filtered-out tickets it links to. Hovering it previews those as translucent
  // ghosts (the ghost effect below), so you can inspect a connection the current filters would otherwise hide.
  const previewReveal = useMemo(() => {
    const structural = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
    const reveal = new Map<string, Set<string>>();
    const add = (host: string, ghost: string) => {
      const ghosts = reveal.get(host) ?? new Set<string>();
      ghosts.add(ghost);
      reveal.set(host, ghosts);
    };
    for (const item of items) {
      for (const dep of item.deps) {
        if (structural(dep, item.id)) continue;
        if (hiddenIds.has(item.id) && !hiddenIds.has(dep)) add(dep, item.id);
        if (hiddenIds.has(dep) && !hiddenIds.has(item.id)) add(item.id, dep);
      }
    }
    return reveal;
  }, [items, hiddenIds]);

  // React Flow needs controlled node/edge state (with change handlers) for dragging to take effect. The
  // layout is rebuilt from the markers whenever the filters/colour/selection change, but any node the user
  // has dragged keeps its manual position (tracked in `draggedPositions`), so re-layouts don't undo drags.
  // Explicit generics: an empty literal would otherwise infer `never[]` and every later setNodes/setEdges
  // call would be a type error against it.
  const [nodes, setNodes] = useNodesState<RoadmapNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Manual layout overrides, applied on top of the auto-layout and persisted to localStorage: dragged node
  // positions and hand-resized box sizes. Both are keyed by node id, so they survive re-layouts and reloads.
  const draggedPositions = useRef<Record<string, XYPosition>>(loadPositions(scope));
  const resizedSizes = useRef<Record<string, BoxSize>>(loadSizes(scope));

  const handleNodesChange = useCallback(
    (changes: NodeChange<RoadmapNode>[]) => {
      let positionEnded = false;
      let sizeEnded = false;
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          draggedPositions.current[change.id] = change.position;
          if (change.dragging === false) positionEnded = true;
        } else if (change.type === "dimensions" && change.dimensions) {
          resizedSizes.current[change.id] = change.dimensions;
          if (change.resizing === false) sizeEnded = true;
        }
      }
      if (positionEnded) savePositions(scope, draggedPositions.current);
      if (sizeEnded) saveSizes(scope, resizedSizes.current);
      setNodes((current) => applyNodeChanges(changes, current));
    },
    [scope, setNodes],
  );

  const resetLayout = useCallback(() => {
    const hasManualLayout =
      Object.keys(draggedPositions.current).length > 0 || Object.keys(resizedSizes.current).length > 0;
    if (hasManualLayout && !window.confirm("Reset the layout? This discards your saved node positions and sizes.")) {
      return;
    }
    clearLayout(scope);
    draggedPositions.current = {};
    resizedSizes.current = {};
    setLayoutNonce((nonce) => nonce + 1);
  }, [scope]);

  useEffect(() => {
    // Lay out the full item set (so filtering only toggles `hidden`, never re-flows), then apply the manual
    // position/size overrides. Nodes deliberately do NOT depend on `hoveredId` - hover restyles edges only
    // (see the edge effect below), so it never rebuilds and repaints the node layer.
    const nodes = buildGraph(items, areas, colours, colourMode, selectedId, hiddenIds);
    setNodes(
      nodes.map((node) => {
        const dragged = draggedPositions.current[node.id];
        const resized = resizedSizes.current[node.id];
        const position = dragged ?? node.position;
        const style = resized ? { ...node.style, width: resized.width, height: resized.height } : node.style;
        return { ...node, position, style };
      }),
    );
    // layoutNonce forces a re-run after a reset (the override refs were cleared).
  }, [items, areas, colours, colourMode, selectedId, hiddenIds, layoutNonce, setNodes]);

  // Edges are their own layer: hover and selection restyle them here without touching the node layout above.
  useEffect(() => {
    setEdges(buildEdges(items, colours, colourMode, selectedId, hoveredId, hoveredEdgeId, hiddenIds));
  }, [items, colours, colourMode, selectedId, hoveredId, hoveredEdgeId, hiddenIds, setEdges]);

  // Ghost preview: while a ticket with filtered-out links is hovered, un-hide those neighbours as translucent
  // ghosts (and restore them on leave). A targeted patch of just those nodes - not a rebuild - so the rest of
  // the graph never repaints. Their edges are revealed by `buildEdges` (see `ghostRevealed`).
  const ghostedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ghosts = (hoveredId ? previewReveal.get(hoveredId) : undefined) ?? new Set<string>();
    const previous = ghostedRef.current;
    if (ghosts.size === 0 && previous.size === 0) return;
    setNodes((current) =>
      current.map((node) => {
        if (ghosts.has(node.id)) return { ...node, hidden: false, style: { ...node.style, opacity: 0.42 } };
        if (previous.has(node.id)) {
          const style = { ...node.style };
          delete style.opacity;
          return { ...node, hidden: hiddenIds.has(node.id), style };
        }
        return node;
      }),
    );
    ghostedRef.current = ghosts;
  }, [hoveredId, previewReveal, hiddenIds, setNodes]);

  const selected = selectedId ? (items.find((item) => item.id === selectedId) ?? null) : null;
  const detail = selected ? (project?.bodies.get(selected.id) ?? "") : "";

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const onNodeClick: NodeMouseHandler = (_event, node) => {
    if (node.type === "item" || node.type === "ticket") {
      setSelectedId((node.data as { item: RoadmapItem }).item.id);
    }
  };

  // Hover a ticket that has a dependency path to light the paths directly attached to it (dependency-free cards
  // and area boxes are ignored); hover an edge to light just that one.
  const onNodeMouseEnter: NodeMouseHandler = (_event, node) => {
    if (linkedNodes.has(node.id)) setHoveredId(node.id);
  };
  const onNodeMouseLeave: NodeMouseHandler = () => setHoveredId(null);
  const onEdgeMouseEnter: EdgeMouseHandler = (_event, edge) => setHoveredEdgeId(edge.id);
  const onEdgeMouseLeave: EdgeMouseHandler = () => setHoveredEdgeId(null);

  const counts = useMemo(() => {
    const byArea = new Map<string, number>();
    const byStatus = new Map<Status, number>();
    for (const item of items) {
      byArea.set(item.area, (byArea.get(item.area) ?? 0) + 1);
      byStatus.set(item.status, (byStatus.get(item.status) ?? 0) + 1);
    }
    return { byArea, byStatus };
  }, [items]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__title">
          {/* The switcher takes the title's place rather than sitting beside it, since both would be saying the
              project's name. It is absent when there is nothing to switch to, and present with no project
              chosen - landing on the root of a multi-project store is exactly when you need it (VIEW-4). */}
          {plan.projects.length > 1 ? (
            <select
              className="picker"
              aria-label="Project"
              value={project?.key ?? ""}
              // Writing the hash is the navigation: `hashchange` re-runs the selection in `main.tsx`.
              onChange={(event) => {
                window.location.hash = event.target.value;
              }}
            >
              {project === null && <option value="">choose a project</option>}
              {plan.projects.map((candidate) => (
                <option key={candidate.key} value={candidate.key}>
                  {candidate.name}
                </option>
              ))}
            </select>
          ) : (
            <strong>{project?.name ?? "no project"}</strong>
          )}
          {/* No noun after the name. This graph is a roadmap for a software project and a curriculum for a
              language one, and the domain layer is careful not to assume which - the toolbar should not either.
              The store path, not a fixed filename: the viewer renders whichever store was served to it, so
              "which plan am I looking at?" is a real question. Basename inline, since the full path is long
              enough to crowd the toolbar and is only wanted occasionally; all of it on hover. */}
          <span className="topbar__sub" title={plan.storePath ?? "a database is the source of truth here - there is no plan file"}>
            {/* No path in cloud mode (OPS-11), where the database *is* the store. Named rather than left
                blank, because "which plan am I looking at?" still has an answer, just not a filename - and
                the connection string is not it, since it carries a password. */}
            {visibleItems.length} of {items.length} items - {plan.storePath?.split("/").pop() ?? "database"}
          </span>
        </div>
        <div className="filters">
          <div className="filters__group">
            {areas.map((area) => (
              <button
                key={area}
                className="chip"
                data-off={hiddenAreas.has(area)}
                style={{ "--area": colours[area] } as React.CSSProperties}
                onClick={() => setHiddenAreas((set) => toggle(set, area))}
              >
                <span className="chip__dot" />
                {area}
                <span className="chip__count">{counts.byArea.get(area)}</span>
              </button>
            ))}
          </div>
          <div className="filters__group">
            {STATUS_KEYS.map((status) => (
              <button
                key={status}
                className="chip"
                data-off={hiddenStatuses.has(status)}
                style={{ "--area": STATUSES[status].colour } as React.CSSProperties}
                onClick={() => setHiddenStatuses((set) => toggle(set, status))}
              >
                <span className="chip__dot" />
                {STATUSES[status].label}
                <span className="chip__count">{counts.byStatus.get(status) ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="Colour by">
            <span className="segmented__label">colour</span>
            {COLOUR_MODES.map((mode) => (
              <button
                key={mode}
                className="segmented__btn"
                data-on={colourMode === mode}
                onClick={() => setColourMode(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
          <button
            className="chip"
            data-on={locked}
            onClick={() => setLocked((value) => !value)}
            title={locked ? "Unlock to drag / resize nodes" : "Lock the layout: pan without moving nodes"}
          >
            {locked ? "🔒 locked" : "🔓 lock"}
          </button>
          <button className="chip" onClick={resetLayout} title="Clear saved positions and re-run auto-layout">
            reset layout
          </button>
          {/* The count rides on the chip, so closing the panel still leaves the fact that an order exists (and
              how long it is) on screen. */}
          {next.length > 0 && (
            <button
              className="chip"
              data-off={!nextOpen}
              onClick={() => setNextOpen((open) => !open)}
              title="The order agreed with set_next"
            >
              next<span className="chip__count">{next.length}</span>
            </button>
          )}
          {/* Whatever the host adds (`extensions.ts`): nothing, from this package's own two hosts. */}
          {ToolbarActions !== undefined && <ToolbarActions plan={plan} project={project} reload={reload} />}
        </div>
      </header>

      <div className="body">
        <div className="graph">
          {/* Why the graph is empty, said out loud. Rendered over the (empty) canvas rather than instead of it,
              so the toolbar and its switcher stay put and the fix is one click away. */}
          {/* A host that can fill an empty plan says how, in place of the notice (VIEW-24). */}
          {plan.projects.length === 0 && EmptyPlan !== undefined ? (
            <div className="graph__notice">
              <EmptyPlan reload={reload} />
            </div>
          ) : (
            selection.notice !== null && <div className="graph__notice">{selection.notice}</div>
          )}
          {/* Open by default: this is the answer to "what now", which is the question someone opens the viewer
              with. Dismissible rather than hidden - see the state above. */}
          {nextOpen && next.length > 0 && (
            <aside className="next">
              <div className="next__head">
                <span className="next__label">Next</span>
                <button className="next__close" onClick={() => setNextOpen(false)} aria-label="Close">
                  ✕
                </button>
              </div>
              <ol className="next__list">
                {next.map((item, index) => (
                  <li key={item.id}>
                    {/* Clicking a row selects the node, which the detail pane and the graph highlight already
                        handle - that is what makes this a jump list rather than a second copy of the graph.
                        A row filtered out of the graph is dimmed rather than dropped: the agreed order is the
                        agreed order, and silently shortening it under a filter would misreport it. */}
                    <button
                      className="next__item"
                      data-on={selectedId === item.id}
                      data-hidden={hiddenIds.has(item.id)}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <span className="next__pos">{index + 1}</span>
                      <span className="next__id" style={{ color: colours[item.area] }}>
                        {item.id}
                      </span>
                      <span className="next__title">{item.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </aside>
          )}
          <LockContext.Provider value={locked}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={handleNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={onNodeClick}
              onNodeMouseEnter={onNodeMouseEnter}
              onNodeMouseLeave={onNodeMouseLeave}
              onEdgeMouseEnter={onEdgeMouseEnter}
              onEdgeMouseLeave={onEdgeMouseLeave}
              onPaneClick={() => setSelectedId(null)}
              nodesDraggable={!locked}
              fitView
              snapToGrid
              snapGrid={[GRID, GRID]}
              minZoom={0.2}
              maxZoom={1.75}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={GRID} color="#232a33" />
              <MiniMap
                pannable
                zoomable
                nodeColor={(node) => (node.data as { colour?: string }).colour ?? "#2b3644"}
                nodeStrokeColor="#0b0f14"
                nodeBorderRadius={4}
                maskColor="rgba(11,15,20,0.6)"
              />
              <Controls />
            </ReactFlow>
          </LockContext.Provider>
        </div>

        {selected && (
          <aside className="detail">
            <div className="detail__head">
              <div>
                <span className="detail__id" style={{ color: colours[selected.area] }}>
                  {selected.id}
                </span>
                {project && <StatusPicker projectKey={project.key} ref_={selected.id} status={selected.status} reload={reload} />}
              </div>
              <button className="detail__close" onClick={() => setSelectedId(null)} aria-label="Close">
                ×
              </button>
            </div>
            {(selected.start !== undefined || selected.due !== undefined) && (
              <div className="detail__deps">
                {[selected.start && `starts ${fmtDay(selected.start)}`, selected.due && `due ${fmtDay(selected.due)}`].filter(Boolean).join(", ")}
              </div>
            )}
            {selected.deps.length > 0 && (
              <div className="detail__deps">
                depends on:{" "}
                {selected.deps.map((dep, index) => {
                  // A dependency naming another project (`PROJ-11`) has nothing to select: the item may not
                  // even be loaded. Shown as plain text rather than a button that would do nothing when
                  // clicked - the ref itself is the answer to "where does this go".
                  const scope = splitScope(dep);
                  return (
                    <span key={dep}>
                      {index > 0 && ", "}
                      {scope === null ? (
                        <button className="detail__dep" onClick={() => setSelectedId(dep)}>
                          {dep}
                        </button>
                      ) : (
                        <span className="detail__dep detail__dep--elsewhere" title={`${scope.ref} in the ${scope.project} project, which is not open here`}>
                          {dep}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
            <div className="detail__doc">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail}</ReactMarkdown>
            </div>
            {/* Below the prose and above the attachments: the body is the item's settled reasoning, and its
                measurements are evidence about it, which is the slot attachments already established. */}
            {project && <Metrics metrics={project.metrics.get(selected.id) ?? EMPTY} {...sectionProps("metrics")} />}
            {project && (
              <Attachments
                {...sectionProps("images")}
                projectKey={project.key}
                ref_={selected.id}
                images={project.attachments.get(selected.id) ?? EMPTY}
                uploadsDisabled={plan.uploadsDisabled}
                reload={reload}
              />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
