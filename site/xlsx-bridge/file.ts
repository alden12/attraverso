/**
 * The plan spreadsheet on this computer, through the browser (`DIST-9.1`): picked once with the File System Access
 * API, remembered across reloads, and read as bytes. Chromium only (Chrome, Edge), which is what a locked-down
 * Windows machine has; Firefox and Safari cannot open a file to follow it, and the page says so.
 *
 * **Read only, and never anything else.** The workbook is the plan (`site/workbook/model.ts`), so the page has no
 * reason to write: the file is asked for with `mode: "read"`, and the browser's own prompt says the page can look
 * and not change.
 */

/** The parts of the File System Access API this page uses, which TypeScript's DOM library does not all declare. */
interface SheetHandle extends FileSystemFileHandle {
  queryPermission(options: { mode: "read" }): Promise<PermissionState>;
  requestPermission(options: { mode: "read" }): Promise<PermissionState>;
}
declare global {
  interface Window {
    showOpenFilePicker?: (options: {
      id?: string;
      multiple?: false;
      types?: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<SheetHandle[]>;
  }
}

export const supported = (): boolean => typeof window.showOpenFilePicker === "function";

/** The workbook as read, with what identifies this version for spotting a change. */
export interface SheetRead {
  name: string;
  bytes: Uint8Array;
  modified: number;
  version: string;
}

const versionOf = (file: File) => `${file.lastModified}:${file.size}`;

export async function readSheet(handle: SheetHandle): Promise<SheetRead> {
  const file = await handle.getFile();
  return { name: file.name.replace(/\.xlsx$/i, ""), bytes: new Uint8Array(await file.arrayBuffer()), modified: file.lastModified, version: versionOf(file) };
}

/** Whether the file has changed since `read`: a look at its date and size, no read. */
export async function changedSince(handle: SheetHandle, read: SheetRead): Promise<boolean> {
  return versionOf(await handle.getFile()) !== read.version;
}

// ---- Remembering the file. A handle is structured-cloneable, so IndexedDB keeps it; the permission is not kept,
// so a reload asks again with one click rather than the whole picker.

const DB = "attraverso-xlsx-bridge";
const STORE = "files";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function remember(handle: SheetHandle): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(handle, "last");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Private windows and blocked storage: the file is simply not remembered.
  }
}

export async function remembered(): Promise<SheetHandle | null> {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const request = db.transaction(STORE).objectStore(STORE).get("last");
      request.onsuccess = () => resolve((request.result as SheetHandle | undefined) ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Ask for the spreadsheet. Must be called from a click: browsers only show the picker in answer to one. */
export async function pick(): Promise<SheetHandle> {
  const [handle] = await window.showOpenFilePicker!({
    id: "attraverso-plan",
    types: [{ description: "Excel workbook", accept: { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] } }],
  });
  await remember(handle!);
  return handle!;
}

/** Whether a remembered file can be read now, and if not, ask (again from a click). */
export async function permitted(handle: SheetHandle, ask: boolean): Promise<boolean> {
  if ((await handle.queryPermission({ mode: "read" })) === "granted") return true;
  return ask && (await handle.requestPermission({ mode: "read" })) === "granted";
}

export type { SheetHandle };
