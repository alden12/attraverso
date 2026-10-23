/**
 * What a plan file is called, and where the files that belong to it live (`IMP-20`).
 *
 * The plan is `attraverso.yaml`, one fixed name like `package.json`, so a repo needs nothing configured for the
 * server to find it. It replaced `<name>.apm.yaml`, which is **read indefinitely**: a plan file is committed
 * history, and five repos had one before the rename, so an older checkout must keep loading. Nothing here
 * renames a file on anyone's behalf.
 *
 * Kept apart from `store.ts` so `media/` and `measurements.ts` can share the one rule without importing the
 * whole store layer.
 */
import { basename, join } from "node:path";

/** The plan file's name. */
export const STORE_FILE = "attraverso.yaml";

/** The suffix plan files had before `IMP-20`, still recognised wherever a plan is looked for. */
export const LEGACY_STORE_SUFFIX = ".apm.yaml";

/** Whether a file of this name is a plan file, under either naming. */
export const isStoreFile = (name: string): boolean => name === STORE_FILE || name.endsWith(LEGACY_STORE_SUFFIX);

/** Whether this plan file uses the pre-`IMP-20` name. */
export const isLegacyStore = (storePath: string): boolean => basename(storePath).endsWith(LEGACY_STORE_SUFFIX);

/**
 * The folder beside a plan file that holds its measurements and media: `.attraverso/`, or `.apm/` for a legacy
 * `*.apm.yaml`.
 *
 * **It follows the plan file's name rather than a fixed one**, so a legacy plan never loses its measurements to
 * the rename, and moving a plan over is one decision that moves both: `git mv` the file, then the folder. Any
 * other name, including one given with `--store`, gets the new folder.
 */
export const dataDirFor = (storePath: string): string =>
  join(storePath, "..", isLegacyStore(storePath) ? ".apm" : ".attraverso");
