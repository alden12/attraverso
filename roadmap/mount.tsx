import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App";
import { fetchPlan, selectProject, STORE_ENDPOINT, type Plan } from "./store";
import { startSession, type Session } from "./session";
import { ExtensionsContext, type ViewerExtensions } from "./extensions";

/**
 * The plan arrives over the network now (VIEW-11), so the shell has to handle the two states a build-time
 * import could not have: not loaded yet, and the endpoint not answering. The failure is worth naming rather
 * than leaving a blank page, because its usual cause is concrete and fixable: the viewer was opened without
 * anything serving the store behind it.
 *
 * The shell also owns *which* project is shown (VIEW-4), because that lives in the URL and the URL is the
 * shell's business.
 *
 * And it owns *refetching*, for the same reason: it holds the plan, so anything below that writes (VIEW-17)
 * has to be able to say "that copy is stale now". Without it a write updates a component's local state and
 * nothing else, which looks right until the component unmounts and the change evaporates.
 */
function Root({ extensions }: { extensions: ViewerExtensions }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Null until the host's session provider has answered - see `session.ts`. Without one it answers `local`
  // straight away.
  const [session, setSession] = useState<Session | null>(null);
  const requested = useHashProject();

  useEffect(() => {
    // `startSession` both returns the current session and reports later ones, so the same setter takes both.
    startSession(extensions.session, setSession).then(setSession, () => setSession({ mode: "local" }));
  }, [extensions.session]);

  const load = useCallback(() => {
    fetchPlan().then(setPlan, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  // Deliberately after the session resolves. Fetching first would send a request with no token, get a 401, and
  // show "could not load the plan" to someone whose only problem is not having signed in yet.
  useEffect(() => {
    if (session !== null && session.mode !== "anonymous") load();
  }, [session, load]);

  if (session === null) return <div className="boot">Starting...</div>;

  if (session.mode === "anonymous") {
    return (
      <div className="boot">
        <strong>Sign in to see your projects</strong>
        <span className="boot__hint">This viewer is hosted, so it shows the projects belonging to your account.</span>
        <button className="boot__action" onClick={session.signIn}>
          {session.signInLabel}
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="boot boot--error">
        <strong>Could not load the plan.</strong>
        <span>{error}</span>
        <span className="boot__hint">
          Nothing is serving <code>{STORE_ENDPOINT}</code>. Run <code>yarn viewer</code>, or open the viewer from
          the MCP server so it serves the store it already has loaded.
        </span>
      </div>
    );
  }
  if (!plan) return <div className="boot">Loading the plan...</div>;

  const selection = selectProject(plan.projects, requested);
  // Keyed by project so switching remounts: filters, selection and the manual-layout refs are all per-project,
  // and a remount resets them together rather than each needing its own effect to notice the change.
  return (
    <ExtensionsContext.Provider value={extensions}>
      <App key={selection.project?.key ?? "none"} plan={plan} selection={selection} reload={load} />
    </ExtensionsContext.Provider>
  );
}

/**
 * The project asked for in the URL hash (`#spanish`), or null for none.
 *
 * A hash rather than a path route, deliberately. The viewer is served by two hosts - the Vite dev server's
 * middleware and the MCP server's static host - and the static host 404s anything that is not a real file on
 * disk. A path route would mean adding SPA fallback to both and keeping them in agreement indefinitely, and
 * giving up honest 404s on genuinely missing assets, in exchange for nothing the hash does not provide. The
 * hash is also never sent to the server, so it cannot collide with `/api/store` or an asset path.
 *
 * No router library either: this is one parameter, not navigation between views. Revisit when VIEW-5 wants
 * `#spanish/MCP-3` with back-button behaviour through ticket selections.
 */
function useHashProject(): string | null {
  const read = (): string | null => decodeURIComponent(window.location.hash.replace(/^#/, "")) || null;
  const [requested, setRequested] = useState(read);
  useEffect(() => {
    const onHashChange = (): void => setRequested(read());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return requested;
}

/**
 * Render the viewer into `#root`. This package's own entry (`main.tsx`) passes nothing; a host with accounts
 * or an importer passes them here (`extensions.ts`), from an entry of its own.
 */
export function mountViewer(extensions: ViewerExtensions = {}): void {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root extensions={extensions} />
    </StrictMode>,
  );
}
