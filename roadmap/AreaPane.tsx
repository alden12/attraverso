import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { STATUSES, type RoadmapItem, type Status } from "../scripts/tickets";

const STATUS_KEYS = Object.keys(STATUSES) as Status[];

/**
 * An area in the right-hand pane (`VIEW-49`), opened by clicking its frame: what it is, how far along, and what
 * in it is open. An area is how a big plan is navigated (`VIEW-36` gave each a stable colour and a zoom in the
 * view menu), and before this a click on one only made it draggable.
 *
 * **Everything here is already in the page.** Names and descriptions ride in the feed with the items, so the pane
 * needs no route of its own, unlike an item's, whose body and comments are fetched on open (`VIEW-29`). A
 * description only shows where the plan has one: `PROJ-3` has the column and nothing writes it yet.
 *
 * **Its rows go somewhere**, as the next list's do: an item is selected and panned to, which replaces this pane
 * with the item's, the same one-thing-at-a-time rule the pane already keeps between items and context (`VIEW-30`).
 */
export function AreaPane({
  area,
  name,
  description,
  colour,
  items,
  next,
  hidden,
  onPick,
  onZoom,
  onClose,
}: {
  area: string;
  /** The `areas` row's name, or undefined where the area has none (most are created by filing an item). */
  name: string | undefined;
  description: string | undefined;
  colour: string | undefined;
  /** Every item in the area, in the plan's order. */
  items: RoadmapItem[];
  /** The next list's items that are in this area, in the list's order, with their place in the whole list. */
  next: { item: RoadmapItem; position: number }[];
  /** Refs the filters hide, dimmed rather than dropped, as the next list does. */
  hidden: Set<string>;
  onPick: (item: RoadmapItem) => void;
  onZoom: () => void;
  onClose: () => void;
}) {
  const counts = new Map(STATUS_KEYS.map((status) => [status, items.filter((item) => item.status === status).length]));
  const open = items.filter((item) => item.status !== "done");
  const done = counts.get("done") ?? 0;

  const row = (item: RoadmapItem, lead: string | number) => (
    <li key={item.id}>
      <button className="next__item" data-hidden={hidden.has(item.id)} onClick={() => onPick(item)} title={item.title}>
        <span className="next__pos" style={typeof lead === "string" ? { color: STATUSES[item.status].colour } : undefined}>
          {lead}
        </span>
        <span className="next__id" style={{ color: colour }}>
          {item.id}
        </span>
        <span className="next__title">{item.title}</span>
      </button>
    </li>
  );

  return (
    <aside className="detail" aria-label={`Area ${area}`}>
      <div className="detail__head">
        <div className="area-pane__tools">
          <button className="chip area-pane__zoom" onClick={onZoom}>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="8" cy="8" r="1.6" fill="currentColor" />
              <path d="M8 0.5v2.5M8 13v2.5M0.5 8h2.5M13 8h2.5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            fit to view
          </button>
        </div>
        <button className="detail__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {/* The name the plan gives it, with the key it goes by on refs beside it; the key alone where it has none. */}
      <h2 className="detail__title area-pane__title">
        {name !== undefined && name !== area && <span>{name}</span>}
        <span className="area-pane__key" style={{ color: colour }}>
          {area}
        </span>
      </h2>

      <div className="area-pane__progress">
        <div className="area-pane__bar" role="img" aria-label={`${done} of ${items.length} done`}>
          {STATUS_KEYS.map((status) =>
            (counts.get(status) ?? 0) > 0 ? (
              <span key={status} style={{ flexGrow: counts.get(status), background: STATUSES[status].colour }} title={`${counts.get(status)} ${STATUSES[status].label}`} />
            ) : null,
          )}
        </div>
        <div className="area-pane__counts">
          {STATUS_KEYS.filter((status) => (counts.get(status) ?? 0) > 0).map((status) => (
            <span key={status}>
              <span style={{ color: STATUSES[status].colour }}>{STATUSES[status].icon}</span> {counts.get(status)} {STATUSES[status].label}
            </span>
          ))}
        </div>
      </div>

      {/* Below the progress, where it reads as what the counts are counting. */}
      {description !== undefined && description !== "" && (
        <div className="detail__doc area-pane__description">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{description}</ReactMarkdown>
        </div>
      )}

      {next.length > 0 && (
        <>
          <div className="settings__label area-pane__label">In the next list</div>
          <ol className="next__list area-pane__list">{next.map(({ item, position }) => row(item, position))}</ol>
        </>
      )}

      <div className="settings__label area-pane__label">{open.length === 0 ? "Nothing open" : `Open (${open.length})`}</div>
      {open.length > 0 && <ul className="next__list area-pane__list">{open.map((item) => row(item, STATUSES[item.status].icon))}</ul>}
    </aside>
  );
}
