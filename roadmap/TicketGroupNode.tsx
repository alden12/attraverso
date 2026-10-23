import { useContext } from "react";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { STATUSES } from "../scripts/tickets";
import type { TicketNode } from "./graph";
import { LockContext } from "./lockContext";

/** A parent ticket: a titled box (id + status glyph + title) that frames its sub-tickets. Selectable like a
 *  leaf card (opens its doc block), and shows the selection glow / dimming. */
export function TicketGroupNode({ data }: NodeProps<TicketNode>) {
  const { item, colour, statusColour, count, selected, dimmed, hiddenLinkIn, hiddenLinkOut } = data;
  const status = STATUSES[item.status];
  const locked = useContext(LockContext);
  return (
    <div
      className="ticket-box"
      data-selected={selected}
      data-dimmed={dimmed}
      style={{ "--area": colour } as React.CSSProperties}
    >
      <NodeResizer
        isVisible={selected && !locked}
        minWidth={200}
        minHeight={100}
        lineClassName="box-resize-line"
        handleClassName="box-resize-handle"
      />
      <Handle type="target" position={Position.Left} className={hiddenLinkIn ? "handle--hidden-link" : undefined} />
      <div className="ticket-box__title">
        <span className="ticket-box__id">{item.id}</span>
        <span className="ticket-box__status" title={status?.label ?? item.status} style={{ color: statusColour }}>
          {status?.icon ?? "?"}
        </span>
        <span className="ticket-box__label" data-strike={status?.strike ?? false}>
          {item.title}
        </span>
        <span className="ticket-box__count">{count}</span>
      </div>
      <Handle type="source" position={Position.Right} className={hiddenLinkOut ? "handle--hidden-link" : undefined} />
    </div>
  );
}
