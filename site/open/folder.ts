/**
 * A plan folder on this computer, through the browser (`DIST-9.1`): picked once with the File System Access API,
 * remembered across reloads, and read as text. Chromium only (Chrome, Edge), which is what a locked-down Windows
 * machine has; Firefox and Safari have no folder access, and the page says so.
 *
 * **Read only, for now.** The folder is asked for with `mode: "read"`, so the browser's own prompt says the page
 * can look and not change. Saving back, with the server's stale-write guard and side-file split, is the next step.
 */

/** The parts of the File System Access API this page uses, which TypeScript's DOM library does not all declare. */
interface DirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission(options: { mode: "read" }): Promise<PermissionState>;
  requestPermission(options: { mode: "read" }): Promise<PermissionState>;
  values(): AsyncIterable<FileSystemHandle>;
}
declare global {
  interface Window {
    showDirectoryPicker?: (options: { mode: "read"; id?: string }) => Promise<DirectoryHandle>;
  }
}

export const supported = (): boolean => typeof window.showDirectoryPicker === "function";

/** The plan file names the server finds (`serialise/paths.ts`, restated: it imports Node's path module). */
const STORE_FILE = "attraverso.yaml";
const LEGACY_SUFFIX = ".apm.yaml";
const isStoreFile = (name: string) => name === STORE_FILE || name.endsWith(LEGACY_SUFFIX);
/** A plan file's data folder: `.apm/` beside a legacy `*.apm.yaml`, `.attraverso/` beside anything else. */
const dataDirOf = (name: string) => (name.endsWith(LEGACY_SUFFIX) ? ".apm" : ".attraverso");

/** One plan file and its side files, as text, with what identifies each version for spotting a change. */
export interface PlanFiles {
  name: string;
  plan: string;
  layout: string | null;
  references: string | null;
}
export interface FolderRead {
  folder: string;
  plans: PlanFiles[];
  /** Every file read, by path, as `lastModified:size`: compared on each check to see whether anything moved. */
  versions: Map<string, string>;
}

async function fileIn(dir: FileSystemDirectoryHandle, path: string[]): Promise<File | null> {
  try {
    let at = dir;
    for (const step of path.slice(0, -1)) at = await at.getDirectoryHandle(step);
    return await (await at.getFileHandle(path[path.length - 1]!)).getFile();
  } catch {
    return null; // not there, which is ordinary for a side file
  }
}

/** Every plan file at the top of the folder, with its layout and references files when it has them. */
export async function readFolder(dir: DirectoryHandle): Promise<FolderRead> {
  const names: string[] = [];
  for await (const entry of dir.values()) if (entry.kind === "file" && isStoreFile(entry.name)) names.push(entry.name);
  // The current name first, as the server takes it as primary.
  names.sort((a, b) => (a === STORE_FILE ? -1 : b === STORE_FILE ? 1 : a.localeCompare(b)));
  const versions = new Map<string, string>();
  const read = async (path: string[]): Promise<string | null> => {
    const file = await fileIn(dir, path);
    versions.set(path.join("/"), file === null ? "absent" : `${file.lastModified}:${file.size}`);
    return file === null ? null : file.text();
  };
  const plans: PlanFiles[] = [];
  for (const name of names) {
    plans.push({
      name,
      plan: (await read([name]))!,
      layout: await read([dataDirOf(name), "layout.yaml"]),
      references: await read([dataDirOf(name), "references.yaml"]),
    });
  }
  return { folder: dir.name, plans, versions };
}

/** Whether any file `read` saw has changed since, appeared or gone: one `stat`-like look per file, no reads. */
export async function changedSince(dir: DirectoryHandle, read: FolderRead): Promise<boolean> {
  for (const [path, was] of read.versions) {
    const file = await fileIn(dir, path.split("/"));
    if ((file === null ? "absent" : `${file.lastModified}:${file.size}`) !== was) return true;
  }
  // A plan file added since counts too.
  for await (const entry of dir.values()) if (entry.kind === "file" && isStoreFile(entry.name) && !read.versions.has(entry.name)) return true;
  return false;
}

// ---- Remembering the folder. A handle is structured-cloneable, so IndexedDB keeps it; the permission is not kept,
// so a reload asks again with one click rather than the whole picker.

const DB = "attraverso-open";
const STORE = "folders";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function remember(dir: DirectoryHandle): Promise<void> {
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

export async function remembered(): Promise<DirectoryHandle | null> {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const request = db.transaction(STORE).objectStore(STORE).get("last");
      request.onsuccess = () => resolve((request.result as DirectoryHandle | undefined) ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Ask for a folder. Must be called from a click: browsers only show the picker in answer to one. */
export async function pick(): Promise<DirectoryHandle> {
  const dir = await window.showDirectoryPicker!({ mode: "read", id: "attraverso-plan" });
  await remember(dir);
  return dir;
}

/** Whether a remembered folder can be read now, and if not, ask (again from a click). */
export async function permitted(dir: DirectoryHandle, ask: boolean): Promise<boolean> {
  if ((await dir.queryPermission({ mode: "read" })) === "granted") return true;
  return ask && (await dir.requestPermission({ mode: "read" })) === "granted";
}

export type { DirectoryHandle };
