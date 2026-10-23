import { Handle, Position, type NodeProps } from "@xyflow/react";
import { STATUSES } from "../scripts/tickets";
import type { ItemNode } from "./graph";

/** One roadmap item as a card: a hued rail (the primary colour - status or area), the id + status glyph
 *  (always in the status hue), and the title (struck through for a done item). Selected nodes glow; nodes
 *  unrelated to the selection dim back. */
export function ItemNodeView({ data }: NodeProps<ItemNode>) {
  const { item, colour, statusColour, selected, dimmed, hiddenLinkIn, hiddenLinkOut } = data;
  const status = STATUSES[item.status];
  return (
    <div
      className="item-node"
      data-selected={selected}
      data-dimmed={dimmed}
      style={{ "--area": colour } as React.CSSProperties}
    >
      <Handle type="target" position={Position.Left} className={hiddenLinkIn ? "handle--hidden-link" : undefined} />
      <div className="item-node__rail" />
      <div className="item-node__body">
        <div className="item-node__meta">
          <span className="item-node__id">{item.id}</span>
          <span className="item-node__status" title={status?.label ?? item.status} style={{ color: statusColour }}>
            {status?.icon ?? "?"}
          </span>
        </div>
        <div className="item-node__title" data-strike={status?.strike ?? false}>
          {item.title}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className={hiddenLinkOut ? "handle--hidden-link" : undefined} />
    </div>
  );
}
