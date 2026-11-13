import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App";
import { fetchPlan, CHANGES_ENDPOINT, parseHash, selectProject, STORE_ENDPOINT, type Plan } from "./store";
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
  // A refresh nobody asked for keeps what is on screen if it fails: a blip mid-poll must not swap the graph for
  // "could not load the plan", which is what `load` rightly does when the first load fails.
  const refresh = useCallback(() => {
    fetchPlan().then(setPlan, () => {});
  }, []);
  useLiveRefresh(plan !== null && extensions.liveRefresh !== false, refresh);
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

  const selection = selectProject(plan.projects, requested.project);
  // Keyed by project so switching remounts: filters, selection and the manual-layout refs are all per-project,
  // and a remount resets them together rather than each needing its own effect to notice the change.
  return (
    <ExtensionsContext.Provider value={extensions}>
      <App key={selection.project?.key ?? "none"} plan={plan} selection={selection} focus={requested.item} reload={load} />
    </ExtensionsContext.Provider>
  );
}

/**
 * Live refresh (`VIEW-7`): listen for the plan's version token and refetch the plan when it moves, so a change Claude
 * just made - or a `git pull`, or a hand edit - shows up in an open viewer without a reload. The plan is replaced
 * in place: `App` keeps its key, so the selection, the open pane, the filters and the layout all stay put.
 *
 * **Pushed by the local host** as server-sent events (see `src/mcp/changes.ts`), which watches the plan files, so
 * nothing polls. The first token on each connection is compared with the last one seen, so a change made while
 * the tab was hidden arrives when it comes back. A host without the stream switches it off (`liveRefresh` in
 * `extensions.ts`), as the hosted viewer does (`OPS-18`), so it is never asked at all.
 *
 * **It never runs on forever.** The stream is closed while the tab is hidden and reopened when it is shown. A host
 * without the route that did not say so (an older local one) fails it outright, and that ends
 * it for good; so do `GIVE_UP_AFTER` failed reconnects in a row, a server that went away and did not come back.
 */
const GIVE_UP_AFTER = 5;
function useLiveRefresh(active: boolean, refresh: () => void): void {
  useEffect(() => {
    if (!active || typeof EventSource === "undefined") return;
    let known: string | undefined;
    let source: EventSource | null = null;
    let failures = 0;
    let finished = false;
    const close = () => {
      source?.close();
      source = null;
    };
    const open = () => {
      if (finished || source !== null || document.visibilityState !== "visible") return;
      const stream = new EventSource(CHANGES_ENDPOINT);
      source = stream;
      stream.addEventListener("open", () => (failures = 0));
      stream.addEventListener("version", (event) => {
        const token = (event as MessageEvent<string>).data;
        if (known !== undefined && token !== known) refresh();
        known = token;
      });
      stream.addEventListener("error", () => {
        // CLOSED: the browser will not retry (a 404, or not an event stream). CONNECTING: it is retrying a
        // dropped connection, which is fine for a server restart and pointless for one that is gone.
        if (stream.readyState === EventSource.CLOSED || ++failures >= GIVE_UP_AFTER) {
          finished = true;
          close();
        }
      });
    };
    const onVisibility = () => (document.visibilityState === "visible" ? open() : close());
    open();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      finished = true;
      close();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, refresh]);
}

/**
 * The project asked for in the URL hash (`#spanish`), or null for none, and an item in it if the hash names one
 * (`#spanish/GRAM-3`, see `parseHash`).
 *
 * A hash rather than a path route, deliberately. The viewer is served by two hosts - the Vite dev server's
 * middleware and the MCP server's static host - and the static host 404s anything that is not a real file on
 * disk. A path route would mean adding SPA fallback to both and keeping them in agreement indefinitely, and
 * giving up honest 404s on genuinely missing assets, in exchange for nothing the hash does not provide. The
 * hash is also never sent to the server, so it cannot collide with `/api/store` or an asset path.
 *
 * No router library either: this is a project and an item read from the URL, not navigation between views.
 * Revisit when VIEW-5 wants back-button behaviour through item selections.
 */
function useHashProject(): ReturnType<typeof parseHash> {
  const read = (): ReturnType<typeof parseHash> => parseHash(window.location.hash);
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
