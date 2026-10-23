/**
 * The placeholder for a dependency that names another project (`PROJ-11`).
 *
 * **Deliberately not a card.** A real item card invites a click that opens a detail pane, and there is nothing
 * to open: the item lives in another project's plan, which the viewer renders one at a time and may not even
 * have loaded. So this is a plain, muted chip carrying the scoped ref and a source handle, which is the whole
 * of what it knows and the whole of what the edge needed - where does this go.
 *
 * It carries no status, because this graph cannot know one. Colouring it as unfinished would be a guess, and
 * colouring it as done would be a worse one: an edge hidden on the strength of a wrong guess is a dependency
 * that silently stops being drawn.
 */
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GhostNode } from "./graph";

export function GhostNodeView({ data }: NodeProps<GhostNode>) {
  const { project, ref, dimmed } = data;
  return (
    <div className="ghost-node" data-dimmed={dimmed} title={`${ref} lives in the ${project} project, which is not open here`}>
      <span className="ghost-node__ref">{ref}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
