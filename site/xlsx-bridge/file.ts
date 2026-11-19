/**
 * The folder holding the plan spreadsheet, through the browser (`DIST-9.1`): picked once with the File System Access
 * API, remembered across reloads, and read as bytes. Chromium only (Chrome, Edge), which is what a locked-down
 * Windows machine has; Firefox and Safari cannot open a folder to follow it, and the page says so.
 *
 * **A folder, not a file**, because an assistant that cannot edit a file may still save a new one beside it
 * (`plan_v2.xlsx`, `plan_v3.xlsx`): the page shows the newest version (`versions.ts`) and switches when another
 * appears. **Read only**: the folder is asked for with `mode: "read"`, so the browser's own prompt says the page can
 * look and not change.
 */
import { newest, type FolderEntry } from "./versions";

/** The parts of the File System Access API this page uses, which TypeScript's DOM library does not all declare. */
interface FolderHandle extends FileSystemDirectoryHandle {
  queryPermission(options: { mode: "read" }): Promise<PermissionState>;
  requestPermission(options: { mode: "read" }): Promise<PermissionState>;
  values(): AsyncIterable<FileSystemHandle>;
}
declare global {
  interface Window {
    showDirectoryPicker?: (options: { mode: "read"; id?: string }) => Promise<FolderHandle>;
  }
}

export const supported = (): boolean => typeof window.showDirectoryPicker === "function";

/** The plan as read: which file it came from, its bytes, and what identifies this version for spotting a change. */
export interface SheetRead {
  /** The plan's name, the same across versions. */
  name: string;
  file: string;
  bytes: Uint8Array;
  modified: number;
  version: string;
}

/** Every spreadsheet at the top of the folder, with when it last changed: one look per file, no reads. */
async function entries(dir: FolderHandle): Promise<(FolderEntry & { handle: FileSystemFileHandle })[]> {
  const found: (FolderEntry & { handle: FileSystemFileHandle })[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind !== "file" || !/\.xlsx$/i.test(entry.name)) continue;
    const handle = entry as FileSystemFileHandle;
    found.push({ name: entry.name, modified: (await handle.getFile()).lastModified, handle });
  }
  return found;
}

const versionOf = (file: File) => `${file.name}:${file.lastModified}:${file.size}`;

/** The newest version of the plan named `base` (or, the first time, of whichever plan changed last). */
export async function readSheet(dir: FolderHandle, base?: string): Promise<SheetRead> {
  const all = await entries(dir);
  const latest = newest(all, base);
  if (latest === null) throw new Error(`no spreadsheet${base === undefined ? "" : ` of "${base}"`} in "${dir.name}": pick the folder the .xlsx is saved in`);
  const file = await all.find((e) => e.name === latest.file)!.handle.getFile();
  return { name: latest.base, file: file.name, bytes: new Uint8Array(await file.arrayBuffer()), modified: file.lastModified, version: versionOf(file) };
}

/** Whether there is anything newer than `read`: a newer version of the plan, or its file changed. */
export async function changedSince(dir: FolderHandle, read: SheetRead): Promise<boolean> {
  const all = await entries(dir);
  const latest = newest(all, read.name);
  if (latest === null) return false; // gone, or mid-save: keep showing what there was
  if (latest.file !== read.file) return true;
  return versionOf(await all.find((e) => e.name === latest.file)!.handle.getFile()) !== read.version;
}

// ---- Remembering the folder. A handle is structured-cloneable, so IndexedDB keeps it; the permission is not kept,
// so a reload asks again with one click rather than the whole picker.

const DB = "attraverso-xlsx-bridge";
const STORE = "folders";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Version 2: version 1 remembered a file, before the page followed a folder.
    const request = indexedDB.open(DB, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function remember(dir: FolderHandle): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(dir, "last");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Private windows and blocked storage: the folder is simply not remembered.
  }
}

export async function remembered(): Promise<FolderHandle | null> {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const request = db.transaction(STORE).objectStore(STORE).get("last");
      request.onsuccess = () => resolve((request.result as FolderHandle | undefined) ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Ask for the folder. Must be called from a click: browsers only show the picker in answer to one. */
export async function pick(): Promise<FolderHandle> {
  const dir = await window.showDirectoryPicker!({ mode: "read", id: "attraverso-plan" });
  await remember(dir);
  return dir;
}

/** Whether a remembered folder can be read now, and if not, ask (again from a click). */
export async function permitted(dir: FolderHandle, ask: boolean): Promise<boolean> {
  if ((await dir.queryPermission({ mode: "read" })) === "granted") return true;
  return ask && (await dir.requestPermission({ mode: "read" })) === "granted";
}

export type { FolderHandle };
