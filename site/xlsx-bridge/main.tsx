/**
 * The xlsx bridge on the Pages site (`DIST-9.1`): for a setup where the assistant cannot reach attraverso's MCP
 * server at all, such as Copilot in Excel on a managed machine. The assistant edits a spreadsheet, which is the plan
 * (`site/workbook/model.ts`); this page reads it and shows it in the viewer, with nothing installed, no server and
 * nothing written, and follows the folder it is in, so an edit, or a new version saved beside it (`plan_v2.xlsx`),
 * shows up within a couple of seconds. Opt in, it keeps a copy of every version in a folder of the user's own
 * (`mirror.ts`).
 */
import { StrictMode, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { mountViewer } from "../../roadmap/mount";
import { changedSince, permitted, pick, readSheet, remembered, supported, type FolderHandle } from "./file";
import { chooseMirror, mirrorSource, mirrorState, onMirrorChange, restoreMirror, resumeMirror } from "./mirror";
import { READ_ONLY, startHost } from "./host";
import { follow } from "./follow";
import { writeWorkbook } from "../workbook/xlsx";
import type { Problem } from "../workbook/model";
import "./bridge.css";

/** Open the spreadsheet in the viewer; `problems` hears what is wrong with it on every read. */
async function open(handle: FolderHandle, problems: (list: Problem[]) => void): Promise<void> {
  let read = await readSheet(handle);
  const host = await startHost(read);
  problems(host.problems);
  // Every read goes to the mirror, which copies whatever it is missing, if one is picked.
  mirrorSource(handle, read.name);
  void restoreMirror();
  mountViewer({
    liveRefresh: false,
    // No server here to serve an optional package's tab.
    extensionTabs: false,
    MenuActions: MirrorMenu,
    // When to look is `follow.ts`'s business; the viewer shows the notice while it has paused.
    watch: (changed, paused) =>
      follow(async () => {
        if (!(await changedSince(handle, read))) return;
        read = await readSheet(handle, read.name);
        problems(await host.reload(read));
        mirrorSource(handle, read.name);
        changed();
      }, paused),
  });
}

/** The blank template, downloaded: generated here rather than kept as a file, so it is always this build's. */
async function downloadTemplate(): Promise<void> {
  const bytes = await writeWorkbook();
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: "plan.xlsx" });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** What is wrong with the spreadsheet, over the graph: a count that opens into the list. */
function Problems({ problems }: { problems: Problem[] }) {
  const [open, setOpen] = useState(false);
  if (problems.length === 0) return null;
  return (
    <div className="problems" role="status">
      <button className="problems__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {problems.length === 1 ? "1 problem" : `${problems.length} problems`} in the spreadsheet
      </button>
      {open && (
        <ul className="problems__list">
          {problems.map((p, n) => (
            <li key={n}>
              <strong>{p.at}</strong>: {p.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const aborted = (cause: unknown) => cause instanceof DOMException && cause.name === "AbortError";

/**
 * The copies kept in a folder of the user's (`mirror.ts`), as an entry in the viewer's menu: rarely set, so behind
 * the menu rather than over the graph. Its state lives in `mirror.ts`, since the menu unmounts when it closes and
 * the copying must not stop with it.
 */
function MirrorMenu() {
  const state = useSyncExternalStore(onMirrorChange, mirrorState);
  const note = (text: string, error = false) => <span className={error ? "mirror-note mirror-note--error" : "mirror-note"}>{text}</span>;
  return (
    <>
      {state.kind === "off" && (
        <button className="chip" onClick={() => void chooseMirror()} title="Copy every version of the plan into a folder of yours, as a backup">
          keep copies in a folder
        </button>
      )}
      {state.kind === "paused" && (
        <button className="chip" onClick={() => void resumeMirror()} title="The browser wants asking again before writing there">
          keep copying to {state.dir.name}
        </button>
      )}
      {state.kind === "on" && (
        <>
          {note(state.note)}
          <button className="chip" onClick={() => void chooseMirror()}>
            change folder
          </button>
        </>
      )}
      {state.kind === "error" && (
        <>
          {note(state.message, true)}
          <button className="chip" onClick={() => void chooseMirror()}>
            pick a folder
          </button>
        </>
      )}
    </>
  );
}

let opening = false;

function Bridge() {
  const [problems, setProblems] = useState<Problem[] | null>(null);
  const [saved, setSaved] = useState<FolderHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async (choose: () => Promise<FolderHandle>) => {
    // Once: StrictMode runs the effect below twice, and a second viewer over the first is two of everything.
    if (opening) return;
    opening = true;
    setBusy(true);
    setError(null);
    try {
      await open(await choose(), setProblems);
    } catch (cause) {
      // Closing the picker is not an error worth showing.
      if (!aborted(cause)) setError(messageOf(cause));
      setBusy(false);
      opening = false;
    }
  };

  useEffect(() => {
    // A file opened before, still permitted: straight in. Permitted but needing a click: offer it by name.
    remembered().then(async (handle) => {
      if (handle === null) return;
      if (await permitted(handle, false)) void go(() => Promise.resolve(handle));
      else setSaved(handle);
    });
  }, []);

  if (problems !== null) return <Problems problems={problems} />;
  return (
    <main className="bridge">
      <h1>xlsx bridge</h1>
      <p>
        For when your assistant cannot connect to attraverso directly, such as using a managed machine where you
        cannot install software or link additional tools to your agent. The assistant edits a spreadsheet, and this
        page shows that spreadsheet as a plan.
      </p>
      <ol>
        <li>
          <button className="link" onClick={() => void downloadTemplate()}>
            Download the template
          </button>{" "}
          and save it where your assistant can edit it (for Copilot, in OneDrive or SharePoint, with AutoSave on).
        </li>
        <li>Ask the assistant to fill it in: its Read me sheet tells it how.</li>
        <li>
          Open the folder it is in to see the plan. The page follows it: when the spreadsheet changes, or a new version
          is saved beside it (<code>plan_v2.xlsx</code>, <code>plan_v3.xlsx</code>), it shows the newest.
        </li>
      </ol>
      {!supported() ? (
        <p className="bridge__error">Opening the folder needs Chrome or Edge: other browsers do not let a page follow a folder on your computer.</p>
      ) : (
        <>
          <p className="bridge__note">
            {READ_ONLY} It is read here, in this browser, and never leaves your computer. Once it is open, its menu can have it
            keep a copy of every version in a folder of your own.
          </p>
          <div className="bridge__actions">
            {saved !== null && (
              <button disabled={busy} onClick={() => go(async () => ((await permitted(saved, true)) ? saved : Promise.reject(new Error("permission was not given"))))}>
                Reopen {saved.name}
              </button>
            )}
            <button disabled={busy} className={saved === null ? "" : "secondary"} onClick={() => go(pick)}>
              {saved === null ? "Open the folder" : "Open another"}
            </button>
          </div>
        </>
      )}
      {busy && <p className="bridge__note">Loading the plan...</p>}
      {error !== null && <p className="bridge__error">{error}</p>}
    </main>
  );
}

createRoot(document.getElementById("bridge")!).render(
  <StrictMode>
    <Bridge />
  </StrictMode>,
);
