/**
 * `/open` on the Pages site (`DIST-9.1`): pick a plan folder on this computer and see it in the viewer, with nothing
 * installed and no server. Read only for now; the page follows the files, so an agent editing them (through the MCP
 * tools, or the workbook applied from the command line) shows up here within a couple of seconds.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { mountViewer } from "../../roadmap/mount";
import { changedSince, permitted, pick, readFolder, remembered, supported, type DirectoryHandle } from "./folder";
import { READ_ONLY, startHost } from "./host";
import { follow } from "./follow";
import "./open.css";

let picker: Root | null = null;

/** The notice that live updates stopped, shown over the viewer and gone the moment someone is back. */
function pausedNotice(show: boolean): void {
  let notice = document.getElementById("paused");
  if (!show) return notice?.remove();
  if (notice !== null) return;
  notice = document.createElement("div");
  notice.id = "paused";
  notice.className = "paused";
  notice.setAttribute("role", "status");
  notice.textContent = "Live updates paused after 15 minutes without activity. Move the mouse or press a key to pick up any changes.";
  document.body.append(notice);
}

async function open(dir: DirectoryHandle): Promise<void> {
  let read = await readFolder(dir);
  if (read.plans.length === 0) throw new Error(`no plan in "${dir.name}": pick the folder holding attraverso.yaml (or a *.apm.yaml)`);
  const host = await startHost(read);
  picker?.unmount();
  document.getElementById("picker")?.remove();
  mountViewer({
    liveRefresh: false,
    // When to look is `follow.ts`'s business: often while things move, less when quiet, never while hidden, and
    // not at all after a long spell with nobody at the page, which the notice says until someone is back.
    watch: (changed) =>
      follow({
        check: async () => {
          if (!(await changedSince(dir, read))) return false;
          read = await readFolder(dir);
          await host.reload(read);
          changed();
          return true;
        },
        onPause: () => pausedNotice(true),
        onResume: () => pausedNotice(false),
      }),
  });
}

function Picker() {
  const [saved, setSaved] = useState<DirectoryHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A folder opened before, still permitted: straight in. Permitted but needing a click: offer it by name.
    remembered().then(async (dir) => {
      if (dir === null) return;
      if (await permitted(dir, false)) void go(() => Promise.resolve(dir));
      else setSaved(dir);
    });
  }, []);

  const go = async (choose: () => Promise<DirectoryHandle>) => {
    setBusy(true);
    setError(null);
    try {
      await open(await choose());
    } catch (cause) {
      // Closing the picker is not an error worth showing.
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  if (!supported()) {
    return (
      <main className="open">
        <h1>Open a plan folder</h1>
        <p>This needs Chrome or Edge: other browsers do not let a page read a folder on your computer.</p>
      </main>
    );
  }
  return (
    <main className="open">
      <h1>Open a plan folder</h1>
      <p>
        Pick the folder holding your plan (<code>attraverso.yaml</code>). It is read here, in this browser, and never leaves your computer.
      </p>
      <p className="open__note">{READ_ONLY}</p>
      <div className="open__actions">
        {saved !== null && (
          <button disabled={busy} onClick={() => go(async () => ((await permitted(saved, true)) ? saved : Promise.reject(new Error("permission was not given"))))}>
            Reopen {saved.name}
          </button>
        )}
        <button disabled={busy} className={saved === null ? "" : "secondary"} onClick={() => go(pick)}>
          {saved === null ? "Choose a folder" : "Choose another"}
        </button>
      </div>
      {busy && <p className="open__note">Loading the plan...</p>}
      {error !== null && <p className="open__error">{error}</p>}
    </main>
  );
}

picker = createRoot(document.getElementById("picker")!);
picker.render(
  <StrictMode>
    <Picker />
  </StrictMode>,
);
