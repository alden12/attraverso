/**
 * The board (`VIEW-46`): the same items as the graph and the calendar, as a grid of status columns and area lanes.
 * A third lens on one dataset rather than a model of its own - **nothing here is stored**. Columns are the fixed
 * status vocabulary, lanes are the areas (the ref prefix), and the order within a cell comes from the next list,
 * so all three stay derived from status, area and `set_next` and cannot drift from them.
 *
 * The agreed order also gets a lane of its own, first and open: the board is reached from the Next pane, so that
 * is what it is opened to see. The rest start folded to a count per column.
 *
 * It takes whatever the view settings left visible, as the calendar does: a hidden status is a missing column, a
 * hidden area a missing lane, and an area with nothing left showing has no lane at all.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { STATUSES, type RoadmapItem, type Status } from "../scripts/tickets";

/** Left to right in the order work moves through them: the reverse of `STATUSES`, which leads with what shipped. */
export const BOARD_COLUMNS = (Object.keys(STATUSES) as Status[]).reverse();

interface Props {
  /** What the filters left visible, in plan order. */
  items: RoadmapItem[];
  /** Every area in display order; those with nothing visible are skipped. */
  areas: string[];
  hiddenStatuses: ReadonlySet<Status>;
  /** The agreed order (`PROJ-8`), as refs. */
  next: string[];
  colours: Record<string, string>;
  /** An area's own name, where the plan gives it one. */
  areaName: (area: string) => string | null;
  selectedId: string | null;
  /** An item to scroll to, opening its lane if need be; a new object each time it is asked. */
  reveal: { ref: string; nonce: number } | null;
  onSelect: (ref: string) => void;
  /** What sits in the grid's top-left corner, above the lane names and beside the column heads. */
  corner?: ReactNode;
  /** What the lanes are: areas, or when the items were filed or last changed. */
  group?: BoardGroup;
}

/** What the board's lanes are: areas, or time, by when items were filed (`created`) or last changed (`updated`). */
export type BoardGroup = "area" | "created" | "updated";

/** One lane of the board: what it is called, the colour its head is ruled in, and its items in order. */
interface Lane {
  key: string;
  name: string;
  /** A caption under the name: an area's key, where the name is not it. */
  caption?: string;
  colour: string;
  items: RoadmapItem[];
}

/**
 * Lanes by time (`group` other than area): the last day, week and month, then each month before, newest first,
 * and anything without the timestamp last. Buckets are by local day, since "today" means the reader's today. A
 * lane's items run newest first, which is the point of asking for them by date.
 */
export function dateLanes(items: RoadmapItem[], by: "created" | "updated", now: Date = new Date()): Lane[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86_400_000;
  const bucket = (instant: string | undefined): { key: string; name: string; rank: number } => {
    if (instant === undefined) return { key: "d:none", name: "No date", rank: -Infinity };
    const at = new Date(instant);
    if (at.getTime() >= startOfToday) return { key: "d:today", name: "Today", rank: Infinity };
    if (at.getTime() >= startOfToday - 6 * DAY) return { key: "d:week", name: "This week", rank: Infinity - 1 };
    if (at.getTime() >= startOfToday - 29 * DAY) return { key: "d:month", name: "Last 30 days", rank: Infinity - 2 };
    const month = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;
    const name = at.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    return { key: `d:${month}`, name, rank: at.getFullYear() * 12 + at.getMonth() };
  };
  const when = (item: RoadmapItem) => (by === "created" ? item.created : item.updated);
  const lanes = new Map<string, Lane & { rank: number }>();
  for (const item of [...items].sort((a, b) => (when(b) ?? "").localeCompare(when(a) ?? ""))) {
    const { key, name, rank } = bucket(when(item));
    const lane = lanes.get(key) ?? { key, name, colour: "var(--text)", items: [], rank };
    lane.items.push(item);
    lanes.set(key, lane);
  }
  return [...lanes.values()].sort((a, b) => b.rank - a.rank).map(({ rank: _rank, ...lane }) => lane);
}

/**
 * The cards in one cell, in order: the next list's items first in their agreed order (numbered, since that order is
 * the point), then the rest as the plan lists them. Done is the exception, newest first, since the agreed order no
 * longer applies and the question asked of it is "what just shipped".
 */
export function orderCell(cell: RoadmapItem[], next: string[], plan: RoadmapItem[]): RoadmapItem[] {
  const position = new Map(next.map((ref, index) => [ref, index]));
  const planIndex = new Map(plan.map((item, index) => [item.id, index]));
  return [...cell].sort((a, b) => {
    if (a.status === "done" && b.status === "done") return (b.closed ?? "").localeCompare(a.closed ?? "");
    const [pa, pb] = [position.get(a.id), position.get(b.id)];
    if (pa !== undefined || pb !== undefined) return (pa ?? Infinity) - (pb ?? Infinity);
    return planIndex.get(a.id)! - planIndex.get(b.id)!;
  });
}

/** The Next lane's key: lowercase, so it can never be an area's, which are uppercase. */
const NEXT_LANE = "next";

export function Board({ items, areas, hiddenStatuses, next, colours, areaName, selectedId, reveal, onSelect, corner, group = "area" }: Props) {
  const columns = BOARD_COLUMNS.filter((status) => !hiddenStatuses.has(status));
  const position = new Map(next.map((ref, index) => [ref, index + 1]));
  const listed = next.flatMap((ref) => items.find((item) => item.id === ref) ?? []);
  const grouped: Lane[] =
    group === "area"
      ? areas
          .map((area) => ({
            key: area,
            name: areaName(area) ?? area,
            caption: areaName(area) === null ? undefined : area,
            colour: colours[area]!,
            items: items.filter((item) => item.area === area),
          }))
          .filter((lane) => lane.items.length > 0)
      : dateLanes(items, group);
  const lanes: Lane[] = [...(listed.length > 0 ? [{ key: NEXT_LANE, name: "Next", colour: "var(--text)", items: listed }] : []), ...grouped];
  const laneOf = (item: RoadmapItem): string => (group === "area" ? item.area : (grouped.find((lane) => lane.items.includes(item))?.key ?? ""));

  // **Only the Next lane starts open**, and by date the newest lane too: it is what the board is opened to see, and
  // forty open lanes is a wall. A lane opened here stays open while the board is up, and is not remembered past it.
  const firstOpen = (): ReadonlySet<string> => new Set([NEXT_LANE, ...(group !== "area" && grouped[0] ? [grouped[0].key] : [])]);
  const [open, setOpen] = useState<ReadonlySet<string>>(firstOpen);
  useEffect(() => setOpen(firstOpen()), [group]);
  const toggleLane = (key: string) =>
    setOpen((set) => {
      const copy = new Set(set);
      if (!copy.delete(key)) copy.add(key);
      return copy;
    });

  // Revealing an item (a search hit, a jump-list row): where it already shows in the Next lane, scroll there;
  // otherwise open its area's lane first. The scroll waits for the render that opens the lane.
  const board = useRef<HTMLDivElement>(null);
  const pending = useRef<{ lane: string; ref: string } | null>(null);
  useEffect(() => {
    if (reveal === null) return;
    const item = items.find((candidate) => candidate.id === reveal.ref);
    if (item === undefined) return;
    const lane = position.has(item.id) && open.has(NEXT_LANE) ? NEXT_LANE : laneOf(item);
    if (!open.has(lane)) setOpen((set) => new Set(set).add(lane));
    pending.current = { lane, ref: item.id };
    // `position` and `open` are read as they are when the reveal arrives, deliberately: toggling a lane later is
    // not a reason to scroll again.
  }, [reveal, items]);
  useEffect(() => {
    const target = pending.current;
    if (target === null || !open.has(target.lane)) return;
    pending.current = null;
    board.current
      ?.querySelector(`[data-lane="${target.lane}"] [data-ref="${CSS.escape(target.ref)}"]`)
      ?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  });

  if (lanes.length === 0) return <div className="board board--empty">Nothing to show with these filters.</div>;

  return (
    <div ref={board} className="board" role="grid" aria-label="Board" style={{ "--columns": columns.length } as React.CSSProperties}>
      <div className="board__corner" role="columnheader">
        {corner}
      </div>
      {columns.map((status) => (
        <div key={status} className="board__column" role="columnheader" style={{ "--area": STATUSES[status].colour } as React.CSSProperties}>
          <span className="board__column-icon">{STATUSES[status].icon}</span>
          {STATUSES[status].label}
          <span className="board__count">{items.filter((item) => item.status === status).length}</span>
        </div>
      ))}
      {lanes.map((lane) => {
        const isNext = lane.key === NEXT_LANE;
        const name = lane.name;
        const shown = open.has(lane.key);
        return (
          <div
            key={lane.key}
            className="board__lane"
            role="row"
            data-lane={lane.key}
            data-open={shown}
            data-next={isNext}
            style={{ "--area": lane.colour } as React.CSSProperties}
          >
            <button
              className="board__lane-head"
              role="rowheader"
              aria-expanded={shown}
              title={name}
              onClick={() => toggleLane(lane.key)}
            >
              <span className="board__lane-name">
                <span className="board__chevron" aria-hidden="true">
                  {shown ? "▾" : "▸"}
                </span>
                <span className="board__lane-text">{name}</span>
              </span>
              <span className="board__lane-key">
                {lane.caption !== undefined ? `${lane.caption} · ${lane.items.length}` : lane.items.length}
              </span>
            </button>
            {columns.map((status) => {
              const cell = lane.items.filter((item) => item.status === status);
              return (
                <div
                  key={status}
                  className="board__cell"
                  role="gridcell"
                  aria-label={`${name} ${status}`}
                  onClick={shown ? undefined : () => toggleLane(lane.key)}
                >
                  {!shown ? (
                    // Folded, a cell says how many it holds, and a click anywhere on the lane opens it.
                    cell.length > 0 && <span className="board__folded">{cell.length}</span>
                  ) : (
                    // The Next lane keeps the agreed order and a date lane its newest first; an area's cell sorts.
                    (isNext || group !== "area" ? cell : orderCell(cell, next, items)).map((item) => (
                      <button
                        key={item.id}
                        data-ref={item.id}
                        className="board__card"
                        data-on={item.id === selectedId}
                        data-strike={STATUSES[item.status].strike}
                        style={{ "--area": colours[item.area] } as React.CSSProperties}
                        onClick={() => onSelect(item.id)}
                        title={`${item.id} [${STATUSES[item.status].label}] ${item.title}`}
                      >
                        <span className="board__card-head">
                          <span className="board__ref">{item.id}</span>
                          <span className="board__status" style={{ color: STATUSES[item.status].colour }}>
                            {STATUSES[item.status].icon}
                          </span>
                          {position.has(item.id) && (
                            <span className="board__next" title={`Number ${position.get(item.id)} in the next list`}>
                              #{position.get(item.id)}
                            </span>
                          )}
                        </span>
                        <span className="board__title">{item.title}</span>
                      </button>
                    ))
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
