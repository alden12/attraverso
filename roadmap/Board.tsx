/**
 * The board (`VIEW-46`): the same items as the graph and the calendar, as a grid of status columns and area lanes.
 * A third lens on one dataset rather than a model of its own - **nothing here is stored**. Columns are the fixed
 * status vocabulary, lanes are the areas (the ref prefix), and the order within a cell comes from the next list,
 * so all three stay derived from status, area and `set_next` and cannot drift from them.
 *
 * It takes whatever the view settings left visible, as the calendar does: a hidden status is a missing column, a
 * hidden area a missing lane, and an area with nothing left showing has no lane at all.
 */
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
  onSelect: (ref: string) => void;
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

export function Board({ items, areas, hiddenStatuses, next, colours, areaName, selectedId, onSelect }: Props) {
  const columns = BOARD_COLUMNS.filter((status) => !hiddenStatuses.has(status));
  const position = new Map(next.map((ref, index) => [ref, index + 1]));
  const lanes = areas.filter((area) => items.some((item) => item.area === area));

  if (lanes.length === 0) return <div className="board board--empty">Nothing to show with these filters.</div>;

  return (
    <div className="board" role="grid" aria-label="Board" style={{ "--columns": columns.length } as React.CSSProperties}>
      <div className="board__corner" role="columnheader" />
      {columns.map((status) => (
        <div key={status} className="board__column" role="columnheader" style={{ "--area": STATUSES[status].colour } as React.CSSProperties}>
          <span className="board__column-icon">{STATUSES[status].icon}</span>
          {STATUSES[status].label}
          <span className="board__count">{items.filter((item) => item.status === status).length}</span>
        </div>
      ))}
      {lanes.map((area) => {
        const name = areaName(area);
        return (
          <div key={area} className="board__lane" role="row" style={{ "--area": colours[area] } as React.CSSProperties}>
            <div className="board__lane-head" role="rowheader">
              <span className="board__lane-name">{name ?? area}</span>
              {name !== null && <span className="board__lane-key">{area}</span>}
            </div>
            {columns.map((status) => {
              const cell = orderCell(
                items.filter((item) => item.area === area && item.status === status),
                next,
                items,
              );
              return (
                <div key={status} className="board__cell" role="gridcell" aria-label={`${area} ${status}`}>
                  {cell.map((item) => (
                    <button
                      key={item.id}
                      className="board__card"
                      data-on={item.id === selectedId}
                      data-strike={STATUSES[item.status].strike}
                      onClick={() => onSelect(item.id)}
                      title={`${item.id} [${STATUSES[item.status].label}] ${item.title}`}
                    >
                      <span className="board__card-head">
                        <span className="board__ref">{item.id}</span>
                        <span className="board__status" style={{ color: STATUSES[item.status].colour }}>
                          {STATUSES[item.status].icon}
                        </span>
                        {position.has(item.id) && (
                          <span className="board__next" title="Its place in the next list">
                            {position.get(item.id)}
                          </span>
                        )}
                      </span>
                      <span className="board__title">{item.title}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
