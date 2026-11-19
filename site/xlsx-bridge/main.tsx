/**
 * The xlsx bridge on the Pages site (`DIST-9.1`): for a setup where the assistant cannot reach attraverso's MCP
 * server at all, such as Copilot in Excel on a managed machine. The assistant edits a spreadsheet, which is the plan
 * (`site/workbook/model.ts`); this page reads it and shows it in the viewer, with nothing installed, no server and
 * nothing written, and follows the folder it is in, so an edit, or a new version saved beside it (`plan_v2.xlsx`),
 * shows up within a couple of seconds. Opt in, it keeps a copy of every version in a folder of the user's own
 * (`mirror.ts`).
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { mountViewer } from "../../roadmap/mount";
import { changedSince, permitted, pick, readSheet, remembered, supported, type FolderHandle, type SheetRead } from "./file";
import { copyVersions, mirrorPermitted, pickMirror, rememberedMirror, type MirrorFolder } from "./mirror";
import { READ_ONLY, startHost } from "./host";
import { follow } from "./follow";
import { writeWorkbook } from "../workbook/xlsx";
import type { Problem } from "../workbook/model";
import "./bridge.css";

/** Open the spreadsheet in the viewer; `problems` hears what is wrong with it, and `onRead` what was read, every time. */
async function open(handle: FolderHandle, problems: (list: Problem[]) => void, onRead: (read: SheetRead) => void): Promise<void> {
  let read = await readSheet(handle);
  const host = await startHost(read);
  problems(host.problems);
  onRead(read);
  mountViewer({
    liveRefresh: false,
    // When to look is `follow.ts`'s business; the viewer shows the notice while it has paused.
    watch: (changed, paused) =>
      follow(async () => {
        if (!(await changedSince(handle, read))) return;
        read = await readSheet(handle, read.name);
        problems(await host.reload(read));
        onRead(read);
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

/** The plan being followed: its folder, its name, and which file and version of it was read last. */
interface Source {
  dir: FolderHandle;
  read: SheetRead;
}

type MirrorState =
  | { kind: "off" }
  | { kind: "paused"; dir: MirrorFolder }
  | { kind: "on"; dir: MirrorFolder; note: string }
  | { kind: "error"; message: string };

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const aborted = (cause: unknown) => cause instanceof DOMException && cause.name === "AbortError";

/** Copies of every version in a folder of the user's, opt in: off until picked, then kept up as versions appear. */
function Mirror({ source }: { source: Source }) {
  const [state, setState] = useState<MirrorState>({ kind: "off" });
  useEffect(() => {
    // A mirror picked before: on again if the browser still allows writing to it, otherwise one click to resume.
    rememberedMirror().then(async (dir) => {
      if (dir === null) return;
      setState((await mirrorPermitted(dir, false)) ? { kind: "on", dir, note: `Copies kept in ${dir.name}` } : { kind: "paused", dir });
    });
  }, []);

  const dir = state.kind === "on" ? state.dir : null;
  useEffect(() => {
    if (dir === null) return;
    copyVersions(source.dir, dir, source.read.name).then(
      (copied) => copied.length > 0 && setState({ kind: "on", dir, note: `Copied ${copied.at(-1)} to ${dir.name}` }),
      (cause) => setState({ kind: "error", message: `Could not copy to ${dir.name}: ${messageOf(cause)}` }),
    );
  }, [dir, source.dir, source.read.name, source.read.version]);

  const choose = async () => {
    try {
      const picked = await pickMirror(source.dir);
      setState({ kind: "on", dir: picked, note: `Copies kept in ${picked.name}` });
    } catch (cause) {
      if (!aborted(cause)) setState({ kind: "error", message: messageOf(cause) });
    }
  };
  const resume = async (paused: MirrorFolder) => {
    if (await mirrorPermitted(paused, true)) setState({ kind: "on", dir: paused, note: `Copies kept in ${paused.name}` });
  };

  return (
    <div className="mirror">
      {state.kind === "off" && (
        <button className="corner__button" onClick={() => void choose()} title="Copy every version of the plan into a folder of yours, as a backup">
          Keep copies in a folder...
        </button>
      )}
      {state.kind === "paused" && (
        <button className="corner__button" onClick={() => void resume(state.dir)}>
          Keep copying to {state.dir.name}
        </button>
      )}
      {state.kind === "on" && (
        <span className="corner__note">
          {state.note}{" "}
          <button className="link" onClick={() => void choose()}>
            change
          </button>
        </span>
      )}
      {state.kind === "error" && (
        <span className="corner__note corner__note--error">
          {state.message}{" "}
          <button className="link" onClick={() => void choose()}>
            pick a folder
          </button>
        </span>
      )}
    </div>
  );
}

let opening = false;

function Bridge() {
  const [problems, setProblems] = useState<Problem[] | null>(null);
  const [source, setSource] = useState<Source | null>(null);
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
      const dir = await choose();
      await open(dir, setProblems, (read) => setSource({ dir, read }));
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

  if (problems !== null) {
    return (
      <div className="corner">
        <Problems problems={problems} />
        {source !== null && <Mirror source={source} />}
      </div>
    );
  }
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
            {READ_ONLY} It is read here, in this browser, and never leaves your computer. Once it is open, you can have the
            page keep a copy of every version in a folder of your own.
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
