/**
 * What a host adds to the viewer (`DIST-3`).
 *
 * This package serves the viewer two ways, the dev server and the loopback host, and neither has accounts or
 * a way to bring a plan in from elsewhere. A hosted server has both, and they are its business rather than
 * the viewer's: so the viewer leaves named slots and the host fills them, through `mountViewer`. Each slot is
 * optional and absent means the control is absent - never a button onto a route nothing serves.
 */
import { createContext, useContext, type ComponentType } from "react";
import type { SessionProvider } from "./session";
import type { Plan, ProjectPlan } from "./store";

export interface ViewerExtensions {
  /** How this host signs people in. Absent: there is nobody to sign in, and requests go out bare. */
  session?: SessionProvider;
  /** Extra toolbar controls, after the built-in ones. `reload` refetches the plan after a write. */
  ToolbarActions?: ComponentType<{ plan: Plan; project: ProjectPlan | null; reload: () => void }>;
  /** Shown over an empty graph in place of the notice, when this host has a way to fill an empty plan. */
  EmptyPlan?: ComponentType<{ reload: () => void }>;
}

export const ExtensionsContext = createContext<ViewerExtensions>({});

export const useExtensions = (): ViewerExtensions => useContext(ExtensionsContext);
