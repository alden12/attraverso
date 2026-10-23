/**
 * The export/import bundle: a project's plan file and its measurement months in one zip (`OPS-19.3`).
 *
 * The upload route (`VIEW-24`) took a bare plan file, which carries the plan and nothing else. That was
 * right while the move was one-way, and wrong the moment a project comes *back*: measurements live in
 * `.attraverso/measurements/YYYY-MM.yaml` by `IMP-7`'s split-by-volatility rule, so a plan file alone is a partial
 * copy, and writing a partial copy over a complete one loses the difference silently.
 *
 * **The layout inside the zip is the repo's own layout**, not a format of its own:
 *
 * ```
 * attraverso.yaml
 * .attraverso/measurements/2026-08.yaml
 * .attraverso/measurements/2026-09.yaml
 * ```
 *
 * An export from before `IMP-20` holds `<key>.apm.yaml` and `.apm/measurements/` instead, and still imports:
 * the measurements are read from whichever folder belongs to the plan file's name, by the same rule a
 * checkout uses (`dataDirFor`).
 *
 * so unzipping it over the checkout puts every file where that file already lives, and `git diff` is the
 * review. A manifest describing where things should go would be a second source of truth about a layout the
 * repo already defines.
 *
 * **A bare plan file is still accepted on import**, detected by the zip magic number rather than by the
 * file extension or the content type, both of which are the caller's word for it. Someone with a plan file
 * on their phone should not have to zip it first to bring it over, and an old export stays importable.
 *
 * **The event log is deliberately absent.** `IMP-7` specifies `.apm/events.jsonl` and nothing writes it yet:
 * events exist only in the database, and locally that database is rebuilt from YAML on every load, so there
 * is no file format to put them in and no importer to read one. Naming that here matters because it is the
 * one thing a replace destroys that this bundle cannot restore.
 */
import { eq } from "drizzle-orm";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import type { Database } from "../db/client";
import { measurements as measurementsTable } from "../db/schema";
import { measurementFiles, parseMeasurementFile, toRecords, type MeasurementRecord } from "./measurements";
import { dataDirFor, isStoreFile, STORE_FILE } from "./paths";
import { exportStore, restrict, stringifyStore } from "./store";

/** Where a plan file's measurement months sit inside the bundle, mirroring `measurementsDirFor` beside it. */
const measurementsDirIn = (planName: string): string => `${dataDirFor(planName)}/measurements/`;

export interface Bundle {
  /** The plan file's name, as it should land in a checkout (`attraverso.yaml`). */
  name: string;
  /** The plan file's contents, exactly as `stringifyStore` wrote them. */
  text: string;
  measurements: MeasurementRecord[];
}

/** The first four bytes of every zip: `PK\x03\x04`. A bare plan file is YAML and cannot begin with them. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function packBundle(bundle: Bundle): Uint8Array {
  const files: Record<string, Uint8Array> = { [bundle.name]: strToU8(bundle.text) };
  for (const [name, text] of measurementFiles(bundle.measurements)) files[measurementsDirIn(bundle.name) + name] = strToU8(text);
  // `mtime` is left at fflate's default rather than set to now, so exporting an unchanged project twice
  // produces the same bytes. Nothing depends on that today; a diffable export is the habit this whole
  // serialisation layer is built on and there is no reason to break it here.
  return zipSync(files, { level: 6 });
}

/**
 * Read a bundle, or a bare plan file.
 *
 * **Exactly one plan file, and it must be at the root.** Zero means the zip is not an export and says so;
 * more than one means a zip of a whole checkout, where the split plan (`IMP-17`) puts two of them side by
 * side and only the caller knows which project they meant. Refusing names both, which is the answer they can
 * act on - the alternative is importing the wrong half and finding out from the diff a week later.
 */
export function unpackBundle(bytes: Uint8Array, fallbackName: string): Bundle {
  if (!looksLikeZip(bytes)) return { name: fallbackName, text: strFromU8(bytes), measurements: [] };

  const entries = unzipSync(bytes, {
    // Directory entries carry no content, and macOS's Finder writes an `__MACOSX/` shadow tree of resource
    // forks beside the real files - one of which is `._attraverso.yaml`, which would otherwise read as a second
    // plan file and make every Finder-zipped bundle ambiguous.
    filter: (file) => file.size > 0 && !file.name.startsWith("__MACOSX/") && !file.name.split("/").pop()?.startsWith("._"),
  });

  const plans = Object.keys(entries).filter((name) => !name.includes("/") && isStoreFile(name));
  if (plans.length === 0) throw new Error(`no ${STORE_FILE} at the top of that zip - it is not a plan export`);
  if (plans.length > 1) throw new Error(`that zip holds ${plans.length} plan files (${plans.join(", ")}) - import one project at a time`);
  const name = plans[0] as string;
  const measurementsDir = measurementsDirIn(name);

  const measurements: MeasurementRecord[] = [];
  for (const [path, content] of Object.entries(entries)) {
    if (!path.startsWith(measurementsDir) || !path.endsWith(".yaml")) continue;
    try {
      measurements.push(...parseMeasurementFile(strFromU8(content)));
    } catch (cause) {
      // Named, because the alternative is a zod path into an anonymous array and no way to tell which of a
      // year's month files is the broken one.
      throw new Error(`${path} is not a measurement log: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return { name, text: strFromU8(entries[name] as Uint8Array), measurements };
}

/**
 * One project as a bundle, straight from the database - the export half of the round trip (`OPS-19.3`).
 *
 * **Scoped to one project, not to the account.** `restrict` is the same narrowing `saveStore` uses to write
 * one file of a split plan (`IMP-17`), and it is what keeps `apm` and `apm-cloud` in separate files on the
 * way back out. An export of everything the caller owns would be one file holding both, which is precisely
 * the shape the split exists to avoid.
 *
 * **The plan file is `attraverso.yaml`**, the name a checkout looks for (`IMP-20`), because the database does not
 * know what the file was called in the checkout it came from, and nothing records the connection. A plan kept
 * under another name, or split across files, is renamed once by hand on the way back. Storing the source
 * filename would remove that step and costs a column; not worth it while this path is the stopgap `OPS-19.2`
 * replaces.
 */
export async function buildBundle(db: Database, ownerId: string, project: { id: string; key: string }): Promise<Bundle> {
  const store = restrict(await exportStore(db, ownerId), new Set([project.id]));
  const rows = await db.select().from(measurementsTable).where(eq(measurementsTable.projectId, project.id));
  return {
    name: STORE_FILE,
    text: stringifyStore(store),
    measurements: await toRecords(db, project.key, rows),
  };
}
