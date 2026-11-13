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
          {named(data) && <span className="area-box__label">{data.name}</span>}
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
        {named(data) && <span className="area-box__label">{data.name}</span>}
        <span className="area-box__count">{data.count}</span>
      </div>
      {/* What the area is, for when its cards are too small to read (VIEW-52): faded in by `--overview`, which the graph
          sets from the zoom, while the cards fade out over it. Always mounted, so the fade is a style and never a
          re-render, and it lets clicks through to the frame. */}
      {data.byStatus !== undefined && data.foreign !== true && (
        <div className="area-box__overview" aria-hidden="true">
          {/* Sized to fit its own length: about 0.6em a character, so a font of 140cqw over the length fills most of
              the width, capped by height for a wide, short frame and in pixels for a huge one. */}
          <div
            className="area-box__overview-name"
            style={{ fontSize: `min(${140 / Math.max((named(data) ? data.name : data.area).length, 3)}cqw, 30cqh, 110px)` }}
          >
            {named(data) ? data.name : data.area}
          </div>
          {named(data) && <div className="area-box__overview-key">{data.area}</div>}
          <div className="area-box__overview-bar">
            {data.byStatus.map(([status, count]) => (
              <span key={status} style={{ flexGrow: count, background: STATUSES[status].colour }} />
            ))}
          </div>
          <div className="area-box__overview-counts">
            {data.byStatus.map(([status, count]) => (
              <span key={status} style={{ color: STATUSES[status].colour }}>
                {STATUSES[status].icon} {count}
              </span>
            ))}
          </div>
          {data.description !== undefined && data.description !== null && <div className="area-box__overview-description">{data.description}</div>}
        </div>
      )}
    </div>
  );
}

/** Whether the plan gives the area a name of its own, rather than the key it would otherwise be called. */
const named = (data: AreaNode["data"]): data is AreaNode["data"] & { name: string } => data.name !== undefined && data.name !== data.area;
