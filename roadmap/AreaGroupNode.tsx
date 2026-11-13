import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import type { AreaNode } from "./graph";
import { STATUSES } from "../scripts/tickets";

/** The container box for one area (epic): a tinted, titled frame the area's item cards sit inside. Selecting
 *  it (click the frame/title) shows resize handles so the box can be sized by hand; dragging it moves the box
 *  and its children together.
 *
 *  `data-foreign` marks a box standing in for another project's items (`PROJ-11`) rather than holding this
 *  plan's: same frame, drawn as absent, and its title is the project key instead of an area prefix.
 *
 *  Collapsed (`VIEW-34`), the same frame holds a count per status instead of cards, and carries handles, since
 *  the edges of every card it stands for now end on it. Clicking it opens it back out (App). */
export function AreaGroupNode({ data, selected }: NodeProps<AreaNode>) {
  if (data.collapsed !== undefined) {
    return (
      <div className="area-box area-box--collapsed" style={{ "--area": data.colour } as React.CSSProperties} title="Click to open this area">
        <Handle type="target" position={Position.Left} />
        <div className="area-box__title">
          <span className="area-box__name">{data.area}</span>
          <span className="area-box__count">{data.count}</span>
        </div>
        <div className="area-box__summary">
          {data.collapsed.byStatus.map(([status, count]) => (
            <span key={status} className="area-box__status" style={{ color: STATUSES[status].colour }} title={status}>
              {STATUSES[status].icon} {count}
            </span>
          ))}
        </div>
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }
  return (
    <div className="area-box" data-foreign={data.foreign === true} style={{ "--area": data.colour } as React.CSSProperties}>
      <NodeResizer
        isVisible={selected}
        minWidth={220}
        minHeight={120}
        lineClassName="box-resize-line"
        handleClassName="box-resize-handle"
      />
      <div className="area-box__title">
        <span className="area-box__name">{data.area}</span>
        <span className="area-box__count">{data.count}</span>
      </div>
    </div>
  );
}
