import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  ControlButton,
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
  type ReactFlowInstance,
} from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import { Attachments } from "./Attachments";
import { Metrics } from "./Metrics";
import remarkGfm from "remark-gfm";
// The plan is fetched at runtime and handed in by `main.tsx` (VIEW-11), so this component renders whichever
// store was served to it rather than one baked into the bundle, and whichever project of it the URL asked
// for (VIEW-4).
import { canWrite, saveLayout, SECTION_PREFIX, sectionInFocus, type Plan, type Selection } from "./store";
import { useExtensions } from "./extensions";
import { areasOf, STATUSES, type Status, splitScope } from "../scripts/tickets";
import { areaColours, buildGraph, buildEdges, memoryOf, remembered, type ColourMode, type LayoutMemory, type RoadmapNode } from "./graph";
import { ItemNodeView } from "./ItemNode";
import { AreaGroupNode } from "./AreaGroupNode";
import { TicketGroupNode } from "./TicketGroupNode";
import { GhostNodeView } from "./GhostNode";
import { loadMemory, saveMemory, loadSizes, saveSizes, clearLayout, type BoxSize } from "./positions";
import { StatusPicker } from "./StatusPicker";
import type { RoadmapItem } from "../scripts/tickets";
import { Calendar, type CalendarEntry } from "./Calendar";
import { countDated } from "./calendarDates";
import { Logo } from "./Logo";
import { Search } from "./Search";
import { fetchItem, type ItemDetail, type SearchHit } from "./store";
import { Comments } from "./Comments";
import { AreaPane } from "./AreaPane";
import { ZoomFade } from "./ZoomFade";

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

type View = "graph" | "calendar";
const VIEWS: View[] = ["graph", "calendar"];

/** Toolbar icons, drawn inline in `currentColor` so they follow the theme and need no asset or icon library. */
const icon = (paths: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths}
  </svg>
);
const CalendarIcon = () => icon(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>);
const GraphIcon = () => icon(<><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="8" r="2.5" /><circle cx="9" cy="18" r="2.5" /><path d="M8.3 7.2l7.4 0.6M7 8.4l1.6 7.2" /></>);
const SearchIcon = () => icon(<><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>);
const SlidersIcon = () => icon(<><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>);
const MapIcon = () => icon(<><path d="M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2-6-2z" /><path d="M9 4v14M15 6v14" /></>);

/**
 * A per-viewer preference that outlives a remount (`CAL-3`). Switching project remounts `App`, which resets
 * all of its state by design; which view you were in and whether the calendar spans every project are not
 * per-project choices, so they would otherwise reset every time you switched. Wrapped, because storage can be
 * unavailable, and a preference is not worth an error over.
 */
function usePreference<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return allowed.includes(stored as T) ? (stored as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // unavailable storage: the choice still holds until the next remount
      }
    },
    [key],
  );
  return [value, set];
}

/** A planned date (`CAL-1`) as a reader says it, "Mon 2 Nov 2026". Formatted in UTC because the date is a day,
 *  not an instant: in local time, midnight UTC is still the previous evening for anyone west of Greenwich. */
const fmtDay = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function App({ plan, selection, focus, reload }: { plan: Plan; selection: Selection; focus: string | null; reload: () => void }) {
  const project = selection.project;
  const { MenuActions, EmptyPlan } = useExtensions();
  // Manual layout is stored per project, since a node id is a ticket ref and those repeat across projects.
  const scope = project?.key ?? "";
  const items = project?.items ?? NO_ITEMS; // fetched once and held in state above, so the reference is stable
  const areas = useMemo(() => areasOf(items), [items]);
  const colours = useMemo(() => areaColours(areas, project?.areaOrder), [areas, project?.areaOrder]);

  const [hiddenAreas, setHiddenAreas] = useState<Set<string>>(new Set());
  // Finished work is hidden by default: on a plan that has been running a while it is most of the map, and the
  // question the graph answers is what is left. One click in the view settings brings it back.
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<Status>>(new Set<Status>(["done"]));
  const [colourMode, setColourMode] = useState<ColourMode>("area");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The next list and the search box, in the right-hand pane with everything else you open over the graph, so the
  // canvas is left to the graph. The pane holds one thing at a time (VIEW-30): an item, an area, context, or one of
  // these. The next list starts open on a wide screen, as its floating panel did: it answers "what did we agree?",
  // which someone back after three weeks is the least likely to know to ask. A narrow screen starts with the graph.
  const [listShown, setListShown] = useState<"next" | "search" | null>(() =>
    focus === null && (typeof window === "undefined" || window.innerWidth >= 700) ? "next" : null,
  );
  const [searchQuery, setSearchQuery] = useState("");
  // Where an item was opened from, so its pane can offer the way back: the list, the search as it was left, or the
  // area. Opening it from the graph itself leaves nothing to go back to.
  const [cameFrom, setCameFrom] = useState<"next" | "search" | { area: string } | null>(null);
  // The search box (VIEW-25). `/` or Cmd/Ctrl+K opens it from anywhere but a text field, which is where those
  // keys are text.
  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target !== null && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      const shortcut = (event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing);
      if (!shortcut || (typing && event.key === "/")) return;
      event.preventDefault();
      openList("search");
    };
    window.addEventListener("keydown", open);
    return () => window.removeEventListener("keydown", open);
  }, []);
  useEffect(() => {
    if (!settingsOpen) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setSettingsOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [settingsOpen]);
  // Locked by default (VIEW-41): only the selected card or box moves, so panning on a touch screen cannot drag a
  // card by accident. "free" is the old behaviour, for a big rearrangement.
  const [lockMode, setLockMode] = usePreference<"selected" | "free">("attraverso.lock", "selected", ["selected", "free"]);
  const locked = lockMode === "selected";
  // Seeded from the URL (`#apm/CAL-1`), which is how the calendar opens another project's item: it switches
  // project, which remounts this, so the item has to arrive with the new mount.
  // A context section in the hash (`#apm/context:protocol`) opens that section instead (VIEW-30).
  const [selectedId, setSelectedId] = useState<string | null>(sectionInFocus(focus) === null ? focus : null);
  /**
   * The context sections in the right-hand pane (VIEW-30): null when closed, `{ heading: null }` for the list of
   * headings, or one section open. **The pane holds one thing at a time**, an item or context, so opening one
   * closes the other: two pieces of state each believing they own the pane is the fight VIEW-30 warns about.
   */
  const [contextView, setContextView] = useState<{ heading: string | null } | null>(() => {
    const heading = sectionInFocus(focus);
    return heading === null ? null : { heading };
  });
  const openContext = useCallback((heading: string | null) => {
    setSelectedId(null);
    setAreaShown(null);
    setListShown(null);
    setContextView({ heading });
  }, []);
  // An area in the pane (VIEW-49), by key: the third thing it can hold, under the same one-at-a-time rule.
  const [areaShown, setAreaShown] = useState<string | null>(null);
  const openArea = useCallback((area: string) => {
    setSelectedId(null);
    setContextView(null);
    setListShown(null);
    setAreaShown(area);
  }, []);
  function openList(kind: "next" | "search") {
    setSelectedId(null);
    setContextView(null);
    setAreaShown(null);
    setListShown(kind);
  }
  /** Back from an item to where it was opened from. */
  const goBack = (from: NonNullable<typeof cameFrom>) => {
    setCameFrom(null);
    if (typeof from === "string") openList(from);
    else openArea(from.area);
  };
  useEffect(() => {
    if (selectedId === null) return;
    setContextView(null);
    setAreaShown(null);
    setListShown(null);
  }, [selectedId]);
  // An open section is in the URL, so a link to "the storage model" can be shared the way a link to a project can.
  // `replaceState`, not an assignment, because a hash change remounts the viewer (main.tsx) and would close it.
  const sectionShown = contextView?.heading ?? null;
  useEffect(() => {
    if (project === null) return;
    const base = `#${encodeURIComponent(project.key)}`;
    const wanted = sectionShown === null ? null : `${base}/${encodeURIComponent(SECTION_PREFIX + sectionShown)}`;
    const current = window.location.hash;
    if (wanted !== null && current !== wanted) history.replaceState(null, "", wanted);
    // Only tidy a section link away; an item link someone arrived on is left as it was.
    if (wanted === null && sectionInFocus(decodeURIComponent(current.slice(base.length + 1))) !== null) history.replaceState(null, "", base);
  }, [sectionShown, project]);
  // Collapsed areas (VIEW-34): each is a summary box until opened, and the map closes up around it through the
  // same re-layout from memory a filter uses. Open by default, so the map is the whole plan until you fold
  // something away.
  const [collapsedAreas, setCollapsedAreas] = useState<Set<string>>(new Set());
  const expandArea = useCallback((area: string) => {
    setCollapsedAreas((collapsed) => {
      if (!collapsed.has(area)) return collapsed;
      const next = new Set(collapsed);
      next.delete(area);
      return next;
    });
  }, []);
  // Selecting an item, from the next list or a link, opens its area: a selection inside a summary box would show
  // nothing selected.
  useEffect(() => {
    const area = selectedId?.split("-")[0];
    if (area !== undefined) expandArea(area);
  }, [selectedId, expandArea]);
  useEffect(() => {
    const heading = sectionInFocus(focus);
    if (heading === null) setSelectedId(focus);
    else openContext(heading);
  }, [focus, openContext]);
  const [view, setView] = usePreference<View>("attraverso.view", "graph", VIEWS);
  const otherView: View = view === "graph" ? "calendar" : "graph";
  // The minimap is a help on a big screen and a quarter of a small one, so it starts hidden on a narrow one, and
  // the choice is remembered - **separately for each**. One shared choice meant hiding it on a phone-sized
  // window hid it on the desktop too, since every tab of the viewer shares one browser's storage.
  const narrow = typeof window !== "undefined" && window.innerWidth < 700;
  const [minimap, setMinimap] = usePreference<"shown" | "hidden">(
    narrow ? "attraverso.minimap.narrow" : "attraverso.minimap.wide",
    narrow ? "hidden" : "shown",
    ["shown", "hidden"],
  );
  // Every project by default: a calendar is where you see what else is happening that week, and that is rarely
  // confined to one plan. One project is a click away and remembered.
  const [span, setSpan] = usePreference<"project" | "all">("attraverso.calendar.span", "all", ["project", "all"]);
  const allProjects = span === "all" && plan.projects.length > 1;
  const [hoveredId, setHoveredId] = useState<string | null>(null); // a ticket with a dependency path, hovered
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null); // a dependency edge, hovered directly
  const [layoutNonce, setLayoutNonce] = useState(0); // bump to force a fresh auto-layout (e.g. after reset)
  // Which detail-pane sections are collapsed. Held here rather than in each section, so the choice survives
  // the pane unmounting - which happens on every item click. Images and comments start folded: they sit below
  // the prose, which is what an item is opened to read, and their counts still show on the closed heading, so a
  // folded one says whether it holds anything. Metrics stay open, being one line each.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["images", "comments"]));
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
  // An empty next list has nothing to show, so asking for it shows nothing rather than an empty pane.
  const listPane = listShown === "next" && next.length === 0 ? null : listShown;

  // The pane's width, dragged by its left edge and remembered in this browser: how much of the graph to give up
  // is a matter of screen and taste, not of the plan, so it is not saved anywhere shared.
  const [paneWidth, setPaneWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem(PANE_WIDTH_KEY));
      return saved >= PANE_MIN_WIDTH ? saved : PANE_DEFAULT_WIDTH;
    } catch {
      return PANE_DEFAULT_WIDTH;
    }
  });
  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = paneWidth;
    let width = startWidth;
    const move = (moved: PointerEvent) => {
      // Dragged left widens it: the pane is pinned to the right edge.
      width = Math.round(Math.min(Math.max(startWidth + startX - moved.clientX, PANE_MIN_WIDTH), window.innerWidth - 80));
      setPaneWidth(width);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        window.localStorage.setItem(PANE_WIDTH_KEY, String(width));
      } catch {
        // A browser that will not store it keeps the width for this page only.
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

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

  // React Flow needs controlled node/edge state (with change handlers) for dragging to take effect. The layout
  // is rebuilt whenever the items, filters, colour or selection change, from the layout's memory (`VIEW-23.1`):
  // every node's last position, so a rebuild puts things back where they were and a new item makes room for
  // itself instead of reshuffling the map. A drag is written into that memory, so a dropped node becomes its
  // new place and its neighbours are pushed aside around it.
  // Explicit generics: an empty literal would otherwise infer `never[]` and every later setNodes/setEdges
  // call would be a type error against it.
  const [nodes, setNodes] = useNodesState<RoadmapNode>([]);
  // React Flow's handle, for panning to a search hit, and the hit waiting to be panned to: picking one can first
  // unhide or expand it, so the pan waits until its node has been drawn (the effect below).
  const flow = useRef<ReactFlowInstance<RoadmapNode, Edge> | null>(null);
  const [panTo, setPanTo] = useState<string | null>(null);
  useEffect(() => {
    if (panTo === null || flow.current === null) return;
    const node = nodes.find((candidate) => candidate.id === panTo);
    if (node === undefined || node.hidden === true) return;
    // An area's frame fills the canvas (VIEW-36); a card keeps some of its neighbourhood around it.
    const frame = panTo.startsWith("area:");
    void flow.current.fitView({ nodes: [{ id: panTo }], duration: 400, maxZoom: frame ? 1.2 : 1.1, padding: frame ? 0.08 : 0.6 });
    setPanTo(null);
  }, [panTo, nodes]);
  // Zoom to an area's frame from the view menu: the whole frame, open or folded, rather than one card, so a big
  // plan is a menu of places to go. Asking to go to a hidden area shows it first, since that is plainly what was
  // meant, and the pan waits for its frame to be drawn. A narrow screen closes the menu on the way, since it covers
  // the canvas there; a wide one keeps it open, so you can hop from area to area.
  const zoomToArea = (area: string) => {
    setHiddenAreas((set) => (set.has(area) ? toggle(set, area) : set));
    setPanTo(`area:${area}`);
    if (narrow) setSettingsOpen(false);
  };
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // The layout's memory lives in the plan (`VIEW-23.1`), so the map is the same on every device: read from the
  // served plan and saved back through the write path. A host that cannot write (the dev server, a published
  // copy) keeps it in this browser instead, and starts from the plan's when it has none of its own.
  // Hand-resized box sizes stay per browser either way, applied over the layout's own. `parents` is each node's
  // container as last laid out, which a drag needs to record its drop in the memory's container-relative terms;
  // `dropping` holds a drag's latest position until it ends.
  const shared = useMemo(() => canWrite(), []);
  const memory = useRef<LayoutMemory>(
    shared ? (project?.layout ?? {}) : (() => {
      const local = loadMemory(scope);
      return Object.keys(local).length > 0 ? local : (project?.layout ?? {});
    })(),
  );
  // Saves are coalesced: a drag can settle several times in quick succession, and the plan file is rewritten on
  // every save. A failed save keeps the layout in this browser rather than losing it.
  const pendingSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set by a drop or a reset, which must be saved even when the settled layout equals the memory they wrote.
  const unsaved = useRef(false);
  const remember = useCallback(
    (layout: LayoutMemory) => {
      if (!shared) return saveMemory(scope, layout);
      if (pendingSave.current !== null) clearTimeout(pendingSave.current);
      pendingSave.current = setTimeout(() => {
        pendingSave.current = null;
        saveLayout(scope, layout).catch((error: unknown) => {
          console.warn("the layout could not be saved to the plan; keeping it in this browser", error);
          saveMemory(scope, layout);
        });
      }, 400);
    },
    [scope, shared],
  );
  const resizedSizes = useRef<Record<string, BoxSize>>(loadSizes(scope));
  const parents = useRef<Map<string, string | undefined>>(new Map());
  const dropping = useRef<Record<string, XYPosition>>({});

  const handleNodesChange = useCallback(
    (changes: NodeChange<RoadmapNode>[]) => {
      const dropped: string[] = [];
      let sizeEnded = false;
      for (const change of changes) {
        if (change.type === "position") {
          if (change.position) dropping.current[change.id] = change.position;
          if (change.dragging === false) dropped.push(change.id);
        } else if (change.type === "dimensions" && change.dimensions && change.resizing !== undefined) {
          // Only a hand resize: React Flow also reports every node's measured size, without `resizing`, and
          // recording those would pin each box at its old size when the layout later grows it.
          resizedSizes.current[change.id] = change.dimensions;
          if (change.resizing === false) sizeEnded = true;
        }
      }
      if (sizeEnded) saveSizes(scope, resizedSizes.current);
      setNodes((current) => applyNodeChanges(changes, current));
      if (dropped.length > 0) {
        for (const id of dropped) {
          const at = dropping.current[id];
          if (at) memory.current = { ...memory.current, [id]: remembered(parents.current.get(id), at) };
          delete dropping.current[id];
        }
        unsaved.current = true;
        setLayoutNonce((nonce) => nonce + 1); // settle the map around the drop, which then saves it
      }
    },
    [scope, setNodes],
  );

  const resetLayout = useCallback(() => {
    if (!window.confirm("Lay the map out afresh? Everything moves, including anything you arranged by hand.")) return;
    clearLayout(scope);
    memory.current = {};
    resizedSizes.current = {};
    unsaved.current = true;
    setLayoutNonce((nonce) => nonce + 1);
  }, [scope]);

  // A layout that changed on disk while the page was open - a `git stash`, a pull, another tab's drag - replaces
  // this page's memory when a live refresh brings it (VIEW-7). Without this the page kept the positions it opened
  // with and, on its next save, wrote them back over the change: a `git stash` was undone a moment later, and
  // `git stash pop` then conflicted with the page's rewrite. A drag of this page's own still waiting to be saved
  // wins, since its save follows and is the newer of the two.
  const servedLayout = useRef<LayoutMemory>(project?.layout ?? {});
  useEffect(() => {
    const served = project?.layout ?? {};
    if (!shared || sameLayout(served, servedLayout.current)) return;
    servedLayout.current = served;
    if (pendingSave.current !== null || unsaved.current || sameLayout(served, memory.current)) return;
    memory.current = served;
    setLayoutNonce((nonce) => nonce + 1);
  }, [project?.layout, shared]);

  useEffect(() => {
    // Lay out the full item set (so filtering only toggles `hidden`, never re-flows), from the memory, and
    // remember the result. Nodes deliberately do NOT depend on `hoveredId` - hover restyles edges only (see the
    // edge effect below), so it never rebuilds and repaints the node layer.
    const nodes = buildGraph(items, areas, colours, colourMode, selectedId, hiddenIds, memory.current);
    parents.current = new Map(nodes.map((node) => [node.id, node.parentId]));
    const next = memoryOf(nodes);
    if (unsaved.current || !sameLayout(next, memory.current)) {
      unsaved.current = false;
      memory.current = next;
      remember(next);
    }
    // With anything filtered out, what is drawn is the visible items laid out again from that same memory, so
    // the map closes up around what is left instead of showing holes, and opens back out when the filter goes.
    // The memory itself only ever comes from the whole plan, above, so a filter never moves anything for good:
    // `arrange` keeps every visible pair's order, and switching the filter off restores the full map exactly.
    // The filtered-out nodes are still passed, hidden, from the full layout, because hovering a neighbour
    // previews them in place (the ghost effect below) and a hidden child needs its box to exist.
    const shown = items.filter((item) => !hiddenIds.has(item.id));
    let drawn = nodes;
    // A collapsed area is the same move (VIEW-34): drawn small, from the same memory, so the map closes up around
    // it and opens back out exactly when it is opened.
    if (shown.length < items.length || collapsedAreas.size > 0) {
      const full = new Map(nodes.map((node) => [node.id, node]));
      const compact = buildGraph(shown, areasOf(shown), colours, colourMode, selectedId, new Set(), next, collapsedAreas);
      const compactIds = new Set(compact.map((node) => node.id));
      const inCollapsed = (node: RoadmapNode) => node.type !== "ghost" && collapsedAreas.has(node.id.split("-")[0] ?? "");
      // Data from the full pass: it alone knows which links lead to something filtered out (the handle hints)
      // and counts an area's hidden items. Positions and box sizes from the compact one. A collapsed area keeps
      // its own data, which is its summary.
      drawn = [
        ...compact.map((node) =>
          node.type === "area" && node.data.collapsed !== undefined ? node : ({ ...node, data: full.get(node.id)?.data ?? node.data } as RoadmapNode),
        ),
        ...nodes.filter((node) => !compactIds.has(node.id)).map((node) => (inCollapsed(node) ? { ...node, hidden: true } : node)),
      ];
    }
    // React Flow's own selection survives the rebuild: it is what shows an area's resize handles, and the click that
    // opens an area in the pane (VIEW-49) also clears the selected item, which rebuilds the nodes - so without this
    // the handles flashed and vanished whenever an item had been selected first.
    setNodes((current) => {
      const picked = new Set(current.filter((node) => node.selected === true).map((node) => node.id));
      return drawn.map((node) => {
        const resized = resizedSizes.current[node.id];
        const sized = resized ? { ...node, style: { ...node.style, width: resized.width, height: resized.height } } : node;
        return picked.has(node.id) ? { ...sized, selected: true } : sized;
      });
    });
    // layoutNonce forces a re-run after a reset or a drop (the memory ref changed, which React cannot see).
  }, [items, areas, colours, colourMode, selectedId, hiddenIds, collapsedAreas, layoutNonce, remember, setNodes]);

  // Edges are their own layer: hover and selection restyle them here without touching the node layout above.
  useEffect(() => {
    setEdges(buildEdges(items, colours, colourMode, selectedId, hoveredId, hoveredEdgeId, hiddenIds, collapsedAreas));
  }, [items, colours, colourMode, selectedId, hoveredId, hoveredEdgeId, hiddenIds, collapsedAreas, setEdges]);

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

  // While locked, the one node that moves is the selected one: the open item, or whatever React Flow has
  // selected (an area box, which opens nothing). A per-node `draggable` overrides `nodesDraggable`.
  const flowNodes = useMemo(
    () => (locked ? nodes.map((node) => (node.selected || node.id === selectedId ? { ...node, draggable: true } : node)) : nodes),
    [nodes, locked, selectedId],
  );

  const selected = selectedId ? (items.find((item) => item.id === selectedId) ?? null) : null;
  const paneOpen = selected !== null || contextView !== null || areaShown !== null || listPane !== null;
  // Whether the pane's content runs on below its bottom edge, for the fade that says so. Watched rather than
  // computed, since the answer changes with scrolling, with an item's details arriving, with a section opening
  // and with a resize; the scroller is looked up each time, because what the pane holds swaps it for another.
  const paneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pane = paneRef.current;
    if (!paneOpen || pane === null) return;
    const update = () => {
      const scroller = pane.querySelector<HTMLElement>(".detail");
      const more = scroller !== null && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2;
      pane.dataset.more = String(more);
    };
    update();
    pane.addEventListener("scroll", update, true); // scroll does not bubble, so caught on the way down
    const mutations = new MutationObserver(update);
    mutations.observe(pane, { childList: true, subtree: true, characterData: true });
    const sizes = new ResizeObserver(update);
    sizes.observe(pane);
    return () => {
      pane.removeEventListener("scroll", update, true);
      mutations.disconnect();
      sizes.disconnect();
    };
  }, [paneOpen]);

  /**
   * What the calendar places (`CAL-3`). For one project it is exactly what the graph shows - the filters apply
   * and the colour follows the colour toggle. Across every project, the area filters are dropped, since areas
   * are per-project and the chips only list this one's, while the status filters still apply, since status is
   * one vocabulary everywhere. Colour is then by project, which is the question a combined view raises first.
   */
  const projectColours = useMemo(() => areaColours(plan.projects.map((p) => p.key)), [plan.projects]);
  const calendarEntries = useMemo((): CalendarEntry[] => {
    if (allProjects) {
      return plan.projects.flatMap((p) =>
        p.items.filter((item) => !hiddenStatuses.has(item.status)).map((item) => ({ project: p.key, item, colour: projectColours[p.key]! })),
      );
    }
    if (!project) return [];
    return visibleItems.map((item) => ({
      project: project.key,
      item,
      colour: colourMode === "status" ? STATUSES[item.status].colour : colours[item.area]!,
    }));
  }, [allProjects, plan.projects, hiddenStatuses, projectColours, project, visibleItems, colourMode, colours]);
  const datedCount = useMemo(() => countDated(calendarEntries.map((entry) => entry.item)), [calendarEntries]);

  // Another project's item switches project through the URL, which remounts with that item open.
  const selectFromCalendar = (key: string, ref: string) => {
    if (key === project?.key) setSelectedId(ref);
    else window.location.hash = `${encodeURIComponent(key)}/${encodeURIComponent(ref)}`;
  };
  /**
   * The open item's body, comments and images, fetched when the pane opens it (VIEW-29) rather than carried for
   * every item in the bulk feed. Fetched again whenever the plan reloads (`plan` is a new object then), so an
   * upload, a status change or an edit made elsewhere shows up in the pane too. A slow answer for the previous
   * item is aborted rather than allowed to land on the next one.
   */
  const [detail, setDetail] = useState<{ ref: string; state: "loading" | "missing" | "failed" } | ItemDetail | null>(null);
  const selectedRef = selected?.id ?? null;
  useEffect(() => {
    if (selectedRef === null || project === null) return setDetail(null);
    const abort = new AbortController();
    // Keep showing what is already there for this item while it refreshes, so a reload does not flash "loading".
    setDetail((current) => (current !== null && current.ref === selectedRef ? current : { ref: selectedRef, state: "loading" }));
    fetchItem(project.key, selectedRef, abort.signal)
      .then((found) => setDetail(found ?? { ref: selectedRef, state: "missing" }))
      .catch((error: unknown) => {
        if ((error as Error).name !== "AbortError") setDetail({ ref: selectedRef, state: "failed" });
      });
    return () => abort.abort();
  }, [selectedRef, project, plan]);
  const loaded = detail !== null && "body" in detail && detail.ref === selectedRef ? detail : null;

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  /**
   * A search hit, picked (VIEW-25). An item - or a comment, which picks the item it is about - is selected where
   * it sits and panned to, so its dependencies and its box stay in view: the graph's value is the structure
   * around a node. A hit the filters hide brings back its status and its area rather than doing nothing, since
   * someone who picked it wants to see it. A context section opens in the pane.
   */
  const pickHit = (hit: SearchHit) => {
    if (hit.source === "context") return openContext(hit.id);
    const item = hit.ref === null ? undefined : items.find((candidate) => candidate.id === hit.ref);
    if (item === undefined) return;
    goToItem(item);
    setCameFrom("search");
  };
  /** Select an item and pan to it, bringing it back first if the filters hide it. A search hit and a row in the
   *  area pane both land here. */
  const goToItem = (item: RoadmapItem) => {
    if (hiddenIds.has(item.id)) {
      setHiddenStatuses((set) => (set.has(item.status) ? toggle(set, item.status) : set));
      setHiddenAreas((set) => (set.has(item.area) ? toggle(set, item.area) : set));
    }
    setView("graph");
    setSelectedId(item.id);
    setPanTo(item.id);
  };

  const onNodeClick: NodeMouseHandler = (_event, node) => {
    if (node.type === "item" || node.type === "ticket") {
      setSelectedId((node.data as { item: RoadmapItem }).item.id);
      setCameFrom(null);
    }
    const summary = node.data as { area?: string; collapsed?: unknown; foreign?: boolean };
    // A folded summary opens the area, which is what it is for; an open frame shows the area in the pane (VIEW-49).
    // A frame holding another project's items is not an area of this one, so it has nothing to show.
    if (node.type === "area" && summary.area !== undefined) {
      if (summary.collapsed !== undefined) expandArea(summary.area);
      else if (summary.foreign !== true) openArea(summary.area);
    }
  };
  // Double-clicking an open area's frame folds it back up.
  const onNodeDoubleClick: NodeMouseHandler = (_event, node) => {
    const box = node.data as { area?: string; collapsed?: unknown; foreign?: boolean };
    if (node.type === "area" && box.collapsed === undefined && box.foreign !== true && box.area !== undefined) {
      const area = box.area;
      setCollapsedAreas((collapsed) => new Set(collapsed).add(area));
      if (selectedId?.split("-")[0] === area) setSelectedId(null);
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
  const hiddenCount = items.length - visibleItems.length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__title">
          {/* The switcher takes the title's place rather than sitting beside it, since both would be saying the
              project's name. It is absent when there is nothing to switch to, and present with no project
              chosen - landing on the root of a multi-project store is exactly when you need it (VIEW-4). */}
          {/* The mark sits in the name's row rather than in a corner of its own spanning the subtitle too: on a phone
              the toolbar has no width to spare for a mark that tall. */}
          <span className="picker-wrap">
          <Logo className="picker__logo" crop="icon" />
          {/* The name reads as a title, and shows it is a switcher only when hovered, with the plan file as a faint
              caption after it: "which file is this?" is occasional, so it gets a whisper rather than a line. Absent
              in cloud mode, where there is no file (OPS-11).

              **Drawn by us, with the real <select> laid over it, invisible.** A native select can only show its
              chosen option's text, so the caption could not sit inside it; replacing it with a custom dropdown would
              lose the phone's own picker, the keyboard and the screen reader for the sake of one caption. Clicking
              lands on the select, which opens the browser's own list, and the <label> is what ties the two. */}
          {(() => {
            // The project's own plan file, relative to its repo (VIEW-48): a split plan has two, which the
            // basename alone named identically. An older server sends no map, so fall back to the basename.
            const file = project?.file ?? (plan.storePath === null ? null : plan.storePath.split(",")[0]!.split("/").pop()!);
            const caption = file !== null && (
              <span className="picker__file" title={plan.storePath ?? undefined}>
                {file}
              </span>
            );
            if (plan.projects.length <= 1) {
              return (
                <span className="picker picker--static">
                  <strong className="picker__name">{project?.name ?? "no project"}</strong>
                  {caption}
                </span>
              );
            }
            return (
              <label className="picker" title="Switch project">
                <span className="picker__name">{project?.name ?? "choose a project"}</span>
                {caption}
                <select
                  className="picker__native"
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
              </label>
            );
          })()}
          </span>
        </div>
        <div className="filters">
          {/* Toolbar buttons carry their detail underneath rather than inline (a caption below the icon), which
              is what lets the toolbar fit a phone's width in one row. */}
          {/* One button that switches to the other view, rather than a two-way switch: there are only two, so the
              button can name where it goes, and it costs one slot instead of two. */}
          <button
            className="toolbtn"
            aria-label={`Show the ${otherView}`}
            title={`Show the ${otherView}`}
            onClick={() => setView(otherView)}
          >
            <span className="toolbtn__main">{otherView === "calendar" ? <CalendarIcon /> : <GraphIcon />}</span>
            <span className="toolbtn__sub">{otherView}</span>
          </button>
          {/* Everything set occasionally lives in one dialog (VIEW-37): on a phone the toolbar was most of the screen.
              The button says how much is filtered out, because a filter set last week and tucked behind a menu
              otherwise reads as items gone missing. */}
          <button
            className="toolbtn"
            data-on={settingsOpen}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            aria-label="View settings"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <span className="toolbtn__main">
              <SlidersIcon />
              view
            </span>
            <span className="toolbtn__sub">{hiddenCount > 0 ? `${hiddenCount} hidden` : "all shown"}</span>
          </button>
        </div>
        {settingsOpen && (
          <>
            <div className="settings__backdrop" onClick={() => setSettingsOpen(false)} />
            <div className="settings" role="dialog" aria-label="View settings">
              {/* Which plan this is, here rather than under the title, where it was a second line on every screen
                  for a question asked occasionally; the count beside it moved to the view button's caption. The
                  plan file's basename, with the full path on hover. In cloud mode there is no file (OPS-11), so it
                  is the project's name alone: the connection string is not a name, and it carries a password. */}
              <div className="settings__head" title={plan.storePath ?? undefined}>
                {project?.name ?? "No project"}
                {plan.storePath !== null && ` - ${project?.file ?? plan.storePath.split("/").pop()}`}
              </div>
              {!(view === "calendar" && allProjects) && <div className="settings__label">Areas</div>}
              {!(view === "calendar" && allProjects) && (
                <div className="filters__group">
                  {areas.map((area) =>
                    view === "graph" ? (
                      // Two buttons in one pill: the name goes there, the eye beside it shows and hides. Going is the
                      // big target because it is the common act on a big plan; two buttons because one cannot hold another.
                      <span key={area} className="chip-pair" data-off={hiddenAreas.has(area)}>
                        <button
                          className="chip"
                          style={{ "--area": colours[area] } as React.CSSProperties}
                          onClick={() => zoomToArea(area)}
                          title={hiddenAreas.has(area) ? `Show ${area} and zoom to it` : `Zoom to ${area}`}
                        >
                          <span className="chip__dot" />
                          {area}
                          <span className="chip__count">{counts.byArea.get(area)}</span>
                        </button>
                        <button
                          className="chip chip--eye"
                          onClick={() => setHiddenAreas((set) => toggle(set, area))}
                          title={hiddenAreas.has(area) ? `Show ${area}` : `Hide ${area}`}
                          aria-label={hiddenAreas.has(area) ? `Show ${area}` : `Hide ${area}`}
                        >
                          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                            <path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" strokeWidth="1.4" />
                            <circle cx="8" cy="8" r="2" fill="currentColor" />
                            {hiddenAreas.has(area) && <path d="M2.5 13.5l11-11" stroke="currentColor" strokeWidth="1.4" />}
                          </svg>
                        </button>
                      </span>
                    ) : (
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
                    ),
                  )}
                </div>
              )}
              {/* Both, as with expand and collapse: with some hidden, which way one toggle goes is a guess. "Hide all"
                  then one name is the quick way to look at a single area. */}
              {!(view === "calendar" && allProjects) && (
                <div className="settings__row">
                  <button className="chip" disabled={hiddenAreas.size === 0} onClick={() => setHiddenAreas(new Set())}>
                    show all
                  </button>
                  <button
                    className="chip"
                    disabled={areas.every((area) => hiddenAreas.has(area))}
                    onClick={() => setHiddenAreas(new Set(areas))}
                  >
                    hide all
                  </button>
                </div>
              )}
              <div className="settings__label">Statuses</div>
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
              <div className="settings__row">
              {!(view === "calendar" && allProjects) && (
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
              )}
              {view === "calendar" && plan.projects.length > 1 && (
                <button
                  className="chip"
                  data-on={allProjects}
                  onClick={() => setSpan(allProjects ? "project" : "all")}
                  title="Show every project's dated items on one calendar, coloured by project"
                >
                  all projects
                </button>
              )}
              </div>
              {view === "graph" && <div className="settings__label">Layout</div>}
              <div className="settings__row">
              {view === "graph" && (
                <button
                  className="chip"
                  data-on={locked}
                  onClick={() => setLockMode(locked ? "free" : "selected")}
                  title={locked ? "Only the selected item moves. Click to let everything move" : "Everything moves. Click to move only the selected item"}
                >
                  {locked ? "🔒 move selected only" : "🔓 move anything"}
                </button>
              )}
              {/* Both, rather than one toggle: with some areas folded, which way a toggle goes is a guess. */}
              {view === "graph" && (
                <button
                  className="chip"
                  disabled={collapsedAreas.size === 0}
                  onClick={() => setCollapsedAreas(new Set())}
                  title="Open every area. Click a folded area to open just that one"
                >
                  expand all
                </button>
              )}
              {view === "graph" && (
                <button
                  className="chip"
                  disabled={areas.every((area) => collapsedAreas.has(area))}
                  onClick={() => {
                    setSelectedId(null); // or the selection would open its area straight back up
                    setCollapsedAreas(new Set(areas));
                  }}
                  title="Fold every area into a summary. Double-click an open area's frame to fold just that one"
                >
                  collapse all
                </button>
              )}
              {view === "graph" && (
                <button className="chip" onClick={resetLayout} title="Lay the map out afresh, forgetting where everything was">
                  reset layout
                </button>
              )}
              </div>
              {/* Whatever the host adds (`extensions.ts`): nothing, from this package's own two hosts. Here rather than
                  in the toolbar, which keeps to the title and the two view controls. */}
              {MenuActions !== undefined && (
                <>
                  <div className="settings__label">Plan</div>
                  <div className="settings__row">
                    <MenuActions plan={plan} project={project} reload={reload} />
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </header>

      <div className="body" data-pane={paneOpen ? "open" : undefined}>
        <div className="graph">
          {/* Why the graph is empty, said out loud. Rendered over the (empty) canvas rather than instead of it,
              so the toolbar and its switcher stay put and the fix is one click away. */}
          {/* A host that can fill an empty plan says how, in place of the notice (VIEW-24). */}
          {plan.projects.length === 0 && EmptyPlan !== undefined ? (
            <div className="graph__notice">
              <EmptyPlan reload={reload} />
            </div>
          ) : selection.notice !== null && !(view === "calendar" && allProjects) ? (
            <div className="graph__notice">{selection.notice}</div>
          ) : (
            // An empty calendar looks broken unless it says why. Most items have no date, by design (`CAL-1`).
            view === "calendar" &&
            datedCount === 0 && (
              <div className="graph__notice">
                Nothing here has a date yet. Give an item a <code>due</code> (or a <code>start</code>) with{" "}
                <code>edit_item</code> and it appears on the calendar.
              </div>
            )
          )}
          {/* Open by default: this is the answer to "what now", which is the question someone opens the viewer
              with. Dismissible rather than hidden - see the state above. */}
          {/* Collapsed, the agreed order is a button floating where the panel was, rather than a toolbar chip: it
              keeps the count on screen, so closing the panel does not hide that an order exists, and it costs the
              toolbar nothing. */}
          {/* The floating controls at the canvas's top left, in one row: the agreed order, and beside it the
              project's context sections (VIEW-30), which open in the right-hand pane rather than here, since a
              section is too long to read in a panel this size. */}
          {view === "graph" && project !== null && (
          <div className="fabs">
          {next.length > 0 && (
            <button
              className="next-fab"
              data-on={listPane === "next"}
              onClick={() => (listPane === "next" ? setListShown(null) : openList("next"))}
              title="The order agreed with set_next"
            >
              Next<span className="chip__count">{next.length}</span>
            </button>
          )}
          {project !== null && project.context.length > 0 && (
            <button
              className="next-fab"
              data-on={contextView !== null}
              onClick={() => (contextView === null ? openContext(null) : setContextView(null))}
              title="The project's context sections: what it is, and how it is worked on"
            >
              Context<span className="chip__count">{project.context.length}</span>
            </button>
          )}
          {/* Search (VIEW-25), with the other things you open over the canvas rather than in the toolbar, which a
              phone has no room in. Icon-only: the magnifier is the most widely understood one there is. */}
          <button
            className="next-fab next-fab--icon"
            data-on={listPane === "search"}
            aria-label="Search"
            title="Search (/ or Cmd+K)"
            onClick={() => (listPane === "search" ? setListShown(null) : openList("search"))}
          >
            <SearchIcon />
          </button>
          </div>
          )}
          {view === "calendar" ? (
            <Calendar
              entries={calendarEntries}
              multiProject={allProjects}
              selected={project && selectedId ? { project: project.key, ref: selectedId } : null}
              onSelect={selectFromCalendar}
            />
          ) : (
              <ReactFlow
                nodes={flowNodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={handleNodesChange}
                onEdgesChange={onEdgesChange}
                onInit={(instance) => (flow.current = instance)}
                onNodeClick={onNodeClick}
                onNodeDoubleClick={onNodeDoubleClick}
                zoomOnDoubleClick={false}
                onNodeMouseEnter={onNodeMouseEnter}
                onNodeMouseLeave={onNodeMouseLeave}
                onEdgeMouseEnter={onEdgeMouseEnter}
                onEdgeMouseLeave={onEdgeMouseLeave}
                onPaneClick={() => setSelectedId(null)}
                nodesDraggable={!locked}
                // Nothing here creates a dependency from a drag, so a handle that starts one only invites a
                // gesture that goes nowhere, and on a touch screen catches pans meant for the canvas.
                nodesConnectable={false}
                fitView
                snapToGrid
                snapGrid={[GRID, GRID]}
                // Far enough out to see a few hundred items at once: the map is where you find things, and a
                // floor that stops short of the whole of it hides exactly the overview it exists for.
                minZoom={0.05}
                maxZoom={1.75}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={GRID} color="#232a33" />
                <ZoomFade />
                {minimap === "shown" && (
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(node) => (node.data as { colour?: string }).colour ?? "#2b3644"}
                  nodeStrokeColor="#0b0f14"
                  nodeBorderRadius={4}
                  maskColor="rgba(11,15,20,0.6)"
                />
                )}
                {/* Without React Flow's own padlock: the view settings' lock is the one that means something here, and
                    a second, different lock beside the zoom buttons would contradict it. */}
                <Controls showInteractive={false}>
                  <ControlButton
                    onClick={() => setMinimap(minimap === "shown" ? "hidden" : "shown")}
                    title={minimap === "shown" ? "Hide the minimap" : "Show the minimap"}
                    aria-label={minimap === "shown" ? "Hide the minimap" : "Show the minimap"}
                  >
                    <MapIcon />
                  </ControlButton>
                </Controls>
              </ReactFlow>
          )}
        </div>

        {/* The pane floats over the canvas's top right rather than taking a column of its own, and is only as tall
            as what it holds, so a short one (the next list, an area) leaves the graph below it in view. */}
        {paneOpen && (
          <div className="pane" ref={paneRef} style={{ width: paneWidth }}>
            <div className="pane__resize" onPointerDown={startResize} title="Drag to resize" aria-hidden="true" />
        {selected && (
          <aside className="detail">
            <div className="detail__head">
              <div>
                {cameFrom !== null && (
                  <button
                    className="detail__close detail__back"
                    onClick={() => goBack(cameFrom)}
                    aria-label={`Back to ${typeof cameFrom === "string" ? (cameFrom === "next" ? "Next" : "Search") : cameFrom.area}`}
                    title={`Back to ${typeof cameFrom === "string" ? (cameFrom === "next" ? "Next" : "Search") : cameFrom.area}`}
                  >
                    ‹
                  </button>
                )}
                <span className="detail__id" style={{ color: colours[selected.area] }}>
                  {selected.id}
                </span>
                {project && <StatusPicker projectKey={project.key} ref_={selected.id} status={selected.status} reload={reload} />}
              </div>
              <button className="detail__close" onClick={() => setSelectedId(null)} aria-label="Close">
                ×
              </button>
            </div>
            {/* The title in full (VIEW-44): the card on the graph clamps it, and on a narrow screen the pane covers
                the card, so without it nothing here said which item you were reading. */}
            <h2 className="detail__title">{selected.title}</h2>
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
              {loaded !== null ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{loaded.body}</ReactMarkdown>
              ) : (
                <p className="detail__pending">
                  {detail !== null && "state" in detail && detail.state === "missing"
                    ? "This item is no longer in the plan."
                    : detail !== null && "state" in detail && detail.state === "failed"
                      ? "Could not load this item. Try reopening it."
                      : "Loading…"}
                </p>
              )}
            </div>
            {/* Below the prose and above the attachments: the body is the item's settled reasoning, and its
                measurements are evidence about it, which is the slot attachments already established. */}
            {project && <Metrics metrics={project.metrics.get(selected.id) ?? EMPTY} {...sectionProps("metrics")} />}
            {project && (
              <Attachments
                {...sectionProps("images")}
                projectKey={project.key}
                ref_={selected.id}
                images={loaded?.attachments ?? EMPTY}
                uploadsDisabled={plan.uploadsDisabled}
                reload={reload}
              />
            )}
            {/* Last: the running record of why the item moved, below what is settled about it (VIEW-5). */}
            {loaded !== null && <Comments comments={loaded.comments} {...sectionProps("comments")} />}
          </aside>
        )}
        {!selected && contextView === null && areaShown !== null && project !== null && (
          <AreaPane
            area={areaShown}
            name={project.areaInfo[areaShown]?.name}
            description={project.areaInfo[areaShown]?.description}
            colour={colours[areaShown]}
            items={items.filter((item) => item.area === areaShown)}
            next={next.flatMap((item, index) => (item.area === areaShown ? [{ item, position: index + 1 }] : []))}
            hidden={hiddenIds}
            onPick={(item) => {
              goToItem(item);
              setCameFrom({ area: areaShown });
            }}
            onZoom={() => zoomToArea(areaShown)}
            onClose={() => setAreaShown(null)}
          />
        )}
        {!selected && contextView === null && areaShown === null && listPane === "next" && (
          <aside className="detail" aria-label="Next">
            <div className="detail__head">
              <span className="detail__id">Next</span>
              <button className="detail__close" onClick={() => setListShown(null)} aria-label="Close">
                ×
              </button>
            </div>
            <ol className="next__list area-pane__list">
              {next.map((item, index) => (
                <li key={item.id}>
                  {/* Clicking a row selects the node, which the detail pane and the graph highlight already handle -
                      that is what makes this a jump list rather than a second copy of the graph. A row filtered out
                      of the graph is dimmed rather than dropped: the agreed order is the agreed order, and silently
                      shortening it under a filter would misreport it. */}
                  <button
                    className="next__item"
                    data-hidden={hiddenIds.has(item.id)}
                    onClick={() => {
                      goToItem(item);
                      setCameFrom("next");
                    }}
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
        {!selected && contextView === null && areaShown === null && listPane === "search" && project !== null && (
          <Search
            projectKey={project.key}
            colours={colours}
            hidden={hiddenIds}
            titleOf={(ref) => items.find((item) => item.id === ref)?.title}
            query={searchQuery}
            onQuery={setSearchQuery}
            onPick={pickHit}
            onClose={() => setListShown(null)}
          />
        )}
        {!selected && contextView !== null && project !== null && (
          <aside className="detail" aria-label="Context">
            <div className="detail__head">
              <div>
                {contextView.heading !== null && (
                  <button className="detail__close detail__back" onClick={() => setContextView({ heading: null })} aria-label="Back to Context" title="Back to Context">
                    ‹
                  </button>
                )}
                <span className="detail__id">Context</span>
              </div>
              <button className="detail__close" onClick={() => setContextView(null)} aria-label="Close">
                ×
              </button>
            </div>
            {contextView.heading === null ? (
              // The table of contents, never every body at once: a heading is cheap to scan and a body is long,
              // which is why `get_project` names headings and opens one on demand.
              <ul className="context__list">
                {project.context.map((section) => (
                  <li key={section.heading}>
                    <button className="context__item" onClick={() => setContextView({ heading: section.heading })}>
                      {section.heading}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <h2 className="detail__title">{contextView.heading}</h2>
                {/* The item body's renderer, so a section reads the same wherever it is shown. */}
                <div className="detail__doc">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {project.context.find((section) => section.heading === contextView.heading)?.content ?? "This section no longer exists."}
                  </ReactMarkdown>
                </div>
              </>
            )}
          </aside>
        )}
          </div>
        )}
      </div>
    </div>
  );
}

const PANE_WIDTH_KEY = "attraverso.pane.width";
const PANE_DEFAULT_WIDTH = 420;
const PANE_MIN_WIDTH = 300;

/** Two layouts place every node in the same spot, whatever order their keys came in: a layout read back from the
 *  plan file is in the file's order, and one laid out here is in the graph's, and neither difference is a move. */
function sameLayout(a: LayoutMemory, b: LayoutMemory): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => b[key] !== undefined && a[key]!.x === b[key]!.x && a[key]!.y === b[key]!.y);
}
