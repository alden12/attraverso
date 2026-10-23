/**
 * A collapsible block in the detail pane, shared by every panel below an item's prose.
 *
 * **One component rather than a toggle in each panel.** Two implementations of "a heading you can click"
 * drift in exactly the small ways that are most annoying: one animates, one does not; one keeps its state
 * when you switch item, one forgets. The pane is going to grow more of these (`METRIC-4`'s sparkline,
 * `CTX-3`'s observations), so the second one is the moment to stop.
 *
 * **Open by default, and the state lives in the pane's owner.** Collapsed-by-default was tried on the order
 * panel earlier the same day and reversed: hiding a thing behind knowing it is there fails exactly the person
 * least likely to know. And holding the open/closed state here would reset it every time the pane unmounts,
 * which is on every item click - so `App` owns it and it survives moving around the graph.
 *
 * A real `<button>` with `aria-expanded`, because this is a disclosure and the pane has no keyboard path to
 * anything else yet (`VIEW-27`).
 */
import type { ReactNode } from "react";

interface Props {
  title: string;
  /** Shown beside the title, and the only thing visible when collapsed - so a closed section still says
   *  whether it holds anything. Omitted when zero, matching what the panels did before. */
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function Section({ title, count, open, onToggle, children }: Props) {
  return (
    <div className="section">
      <button className="section__head" onClick={onToggle} aria-expanded={open}>
        <span className="section__caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        {title}
        {count !== undefined && count > 0 && <span className="section__count">{count}</span>}
      </button>
      {open && <div className="section__body">{children}</div>}
    </div>
  );
}
