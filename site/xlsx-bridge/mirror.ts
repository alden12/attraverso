/**
 * Copies of the plan in a folder the user owns (`DIST-9.1`), opt in. The folder the assistant saves into is not one
 * the user created or manages (in the field it was a folder Copilot set up in OneDrive), so it could be cleared,
 * moved or swept by a retention policy. With a mirror picked, the page copies **every version** of the plan there,
 * and each new one as it appears: a full history, and a folder the page can open in its own right if the
 * assistant's is ever gone, since the copies keep their names.
 *
 * **The only writing the page does, and narrow by construction.** The browser grants write access to the one folder
 * picked (and nothing outside it), the assistant's folder stays read only, and nothing is ever overwritten: a file
 * already there with the same bytes is skipped, and one with different bytes (a file edited in place) is first kept
 * as `<name>.<time>.bak`, which the version reader ignores.
 */
import { entries, remember, remembered, type FolderHandle } from "./file";
import { versionOf } from "./versions";

/** A folder the page may write to, with the permission calls TypeScript's DOM library does not declare. */
export interface MirrorFolder extends FileSystemDirectoryHandle {
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  values(): AsyncIterable<FileSystemHandle>;
}

/** Ask for the mirror folder, refusing the followed folder itself. Must be called from a click. */
export async function pickMirror(source: FolderHandle): Promise<MirrorFolder> {
  const dir = (await window.showDirectoryPicker!({ mode: "readwrite", id: "attraverso-mirror" })) as unknown as MirrorFolder;
  if (await dir.isSameEntry(source)) throw new Error("that is the folder being followed: pick a folder of your own for the copies");
  await remember(dir, "mirror");
  return dir;
}

export const rememberedMirror = (): Promise<MirrorFolder | null> => remembered<MirrorFolder>("mirror");

/** Whether the page may write to the mirror now, and if not, ask (again from a click). */
export async function mirrorPermitted(dir: MirrorFolder, ask: boolean): Promise<boolean> {
  if ((await dir.queryPermission({ mode: "readwrite" })) === "granted") return true;
  return ask && (await dir.requestPermission({ mode: "readwrite" })) === "granted";
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, n) => byte === b[n]);

async function write(dir: MirrorFolder, name: string, bytes: Uint8Array): Promise<void> {
  // A writable writes to a swap file and replaces the target on close, so a half-written copy is never left behind.
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(bytes as BlobPart);
  await writable.close();
}

/** Copy every version of plan `base` from `source` that the mirror does not hold yet; returns the names copied. */
export async function copyVersions(source: FolderHandle, mirror: MirrorFolder, base: string): Promise<string[]> {
  const copied: string[] = [];
  const versions = (await entries(source)).filter((entry) => versionOf(entry)?.base.toLowerCase() === base.toLowerCase());
  for (const entry of versions.sort((a, b) => versionOf(a)!.version - versionOf(b)!.version)) {
    const bytes = new Uint8Array(await (await entry.handle.getFile()).arrayBuffer());
    const existing = await mirror
      .getFileHandle(entry.name)
      .then((handle) => handle.getFile())
      .catch(() => null);
    if (existing !== null) {
      const had = new Uint8Array(await existing.arrayBuffer());
      if (same(had, bytes)) continue;
      const stamp = new Date(existing.lastModified).toISOString().replace(/[:.]/g, "-");
      await write(mirror, `${entry.name}.${stamp}.bak`, had);
    }
    await write(mirror, entry.name, bytes);
    copied.push(entry.name);
  }
  return copied;
}
