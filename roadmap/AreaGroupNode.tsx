import { useContext } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import type { AreaNode } from "./graph";
import { LockContext } from "./lockContext";

/** The container box for one area (epic): a tinted, titled frame the area's item cards sit inside. Selecting
 *  it (click the frame/title) shows resize handles so the box can be sized by hand; dragging it moves the box
 *  and its children together.
 *
 *  `data-foreign` marks a box standing in for another project's items (`PROJ-11`) rather than holding this
 *  plan's: same frame, drawn as absent, and its title is the project key instead of an area prefix. */
export function AreaGroupNode({ data, selected }: NodeProps<AreaNode>) {
  const locked = useContext(LockContext);
  return (
    <div className="area-box" data-foreign={data.foreign === true} style={{ "--area": data.colour } as React.CSSProperties}>
      <NodeResizer
        isVisible={selected && !locked}
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
