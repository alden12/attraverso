import { createContext } from "react";

/** When true, the map is locked: nodes/boxes can't be dragged or resized (so panning never moves them). Read
 *  by the box node components to hide their resize handles; node dragging is disabled on `<ReactFlow>` itself. */
export const LockContext = createContext(false);
