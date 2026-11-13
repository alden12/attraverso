/**
 * The plan layer as YAML: the durable, human-readable, committable form of a project (IMP-3/4). After the
 * storage pivot this is the *source of truth* - the in-memory PGlite database is rebuilt from it on load
 * (`importStore`) and written back on every mutation (`saveStore`). SQLite is gone; nothing here is a second
 * query engine, only a serialisation of the same rows.
 *
 * Two rules make it trustworthy:
 *
 * - **Deterministic.** Projects by key, areas by key, items by (area, sort_path), deps sorted; timestamps
 *   verbatim; nothing re-derived. So a one-field change is a one-line diff and committing it is meaningful.
 *   `importStore(export)` then `exportStore` round-trips byte-identical (proved in the test).
 * - **Readable, but stable.** Items reference each other by human ref (`parent: MCP-3`, `deps: [DATA-1]`),
 *   which reads well in a diff, while the uuid rides along as `id` so identity survives a rename. On load
 *   the refs are resolved back to ids.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { isStoreFile, layoutPathFor, LEGACY_STORE_SUFFIX, STORE_FILE } from "./paths";
import type { Database } from "../db/client";
import { ensureUser, LOCAL_IDENTITY } from "../domain/users";
import { appendMeasurements, loadMeasurements, measurementsDirFor, readMeasurements, type MeasurementRecord } from "./measurements";
import { exportStore, importStore, mergeLayout, parseLayout, parseStore, replaceStore, splitLayout, stringifyLayout, stringifyStore, type LayoutFile, type Store } from "./plan";

// The plan as data is `plan.ts`, split out so it loads without Node (`DIST-6`). Re-exported, so no import moves.
export * from "./plan";



/**
 * Where the project's YAML lives (IMP-5, repo file mode). In precedence:
 *   1. `explicit` (the server's `--store` CLI arg) or `APM_STORE_PATH` - a file path, absolute or relative to
 *      the working directory. This names the file, so a project can be `spanish.yaml`, anywhere.
 *   2. the nearest `attraverso.yaml` (or legacy `*.apm.yaml`, `IMP-20`) found by walking up from the working
 *      directory - a repo-embedded project, committed at the repo root. Auto-discovery like tsconfig/yarn.lock,
 *      so there is usually nothing to specify. Inside a git repo the walk stops at the repo's root.
 *   3. inside a git repo with no plan yet, `attraverso.yaml` at the repo's root, created on first run - the main
 *      use, so it needs nothing configured (`IMP-20`, the user's call: a plan wanted somewhere else, such as one
 *      shared across repos, is named with `--store`).
 *   4. outside any repo, the home dir - a personal project (a language, houseplants) with no repo to live in,
 *      and where Claude Desktop lands, since launchd starts it at `/`.
 * A missing file at the resolved path is a first run, handled by `openStore`, not an error here.
 *
 * The primary store, when there are several (`IMP-17`): see `resolveStorePaths`.
 */
export function resolveStorePath(explicit?: string): string {
  const [primary] = resolveStorePaths(explicit === undefined ? undefined : [explicit]);
  return primary;
}

/**
 * Every store file to load, primary first (`IMP-17`).
 *
 * One file already holds many projects, so this is not how a second project is added - it is how a project's
 * plan comes from a *different place*, which is what `DIST-3`'s split needs: the open core's plan in the
 * public repo, the commercial plan in the private one, both open at once or the tool is worse at managing
 * its own project than it was before.
 *
 * **Primary is the first entry, and it is where a new project lands**, since `create_project` names no file.
 * That wants to be an explicit answer rather than an accident of iteration order, so it is the one the
 * existing single-file resolution would have picked.
 *
 * `APM_STORE_PATH` splits on the platform's path delimiter, the same convention as `PATH` itself, which
 * carries the same caveat: a POSIX filename may legally contain a colon and one here would be read as two
 * paths. Repeating `--store` avoids the question entirely.
 */
export function resolveStorePaths(explicit?: string[]): [string, ...string[]] {
  const listed = pathList(explicit) ?? pathList([process.env.APM_STORE_PATH]);
  if (listed !== undefined) return listed;
  const repo = repoRootAbove(process.cwd());
  const [first, ...rest] = findStoreUp(process.cwd(), repo);
  if (first !== undefined) return [first, ...rest];
  return [repo === undefined ? homeStorePath() : join(repo, STORE_FILE)];
}

/**
 * The root of the git repo `start` is in, or undefined outside one. `.git` is a directory in a clone and a file
 * in a worktree or submodule, and either marks the root.
 */
function repoRootAbove(start: string): string | undefined {
  for (let dir = start; ; ) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The home store: `attraverso.yaml`, unless only the pre-rename `project.apm.yaml` is there (`IMP-20`), which is
 * then the one in use - a personal plan must not seem to vanish because the default name changed.
 */
function homeStorePath(): string {
  // The directory keeps its pre-rename name for now: moving it is a migration of its own. Read on each call
  // rather than once at import, so a test can point `HOME` somewhere disposable.
  const dir = join(homedir(), ".ai-project-manager");
  const current = join(dir, STORE_FILE);
  const legacy = join(dir, `project${LEGACY_STORE_SUFFIX}`);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

/**
 * The `--store` values in an argv, in order, or undefined if there are none.
 *
 * Repeatable, because a plan can span several files (`IMP-17`), and the first is the primary. A pure
 * function of an argv rather than a reader of `process.argv`, so the server, `apm:check` and the viewer's dev
 * server share one definition instead of three that drift.
 */
export function storePathsIn(argv: string[]): string[] | undefined {
  const found = argv.flatMap((arg, index) => {
    const value = argv[index + 1];
    return arg === "--store" && value !== undefined ? [value] : [];
  });
  return found.length > 0 ? found : undefined;
}

/** The usable paths in a list of possibly-delimited values, or undefined if there are none - so an unset or
 *  entirely placeholder value falls through to the next source rather than resolving to an empty list. */
function pathList(values: (string | undefined)[] | undefined): [string, ...string[]] | undefined {
  const out = (values ?? [])
    .flatMap((value) => (value ?? "").split(delimiter))
    .map((value) => usable(value))
    .filter((value): value is string => value !== undefined)
    .map((path) => (isAbsolute(path) ? path : join(process.cwd(), path)));
  const [first, ...rest] = [...new Set(out)];
  return first === undefined ? undefined : [first, ...rest];
}

/**
 * A path we should actually act on, or undefined. Blank is unset, which matters because the `.mcpb` manifest
 * wires `APM_STORE_PATH` to an optional `user_config` field and an unfilled one arrives as an empty string.
 *
 * The `${` check is the defensive half: if a host ever passes a config placeholder through unsubstituted, we
 * would otherwise try to create a file literally named `${user_config.store_path}` - at `cwd: /` under
 * launchd, which fails with a permission error, kills the server on boot, and presents to the user as "the
 * tools did not appear" with nothing pointing at the cause. Falling back to the default is the better failure.
 */
function usable(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed || trimmed.includes("${")) return undefined;
  return trimmed;
}

/**
 * Walk up from `start` for the nearest directory holding plan files - `attraverso.yaml`, or legacy `*.apm.yaml`
 * (`IMP-20`) - and return **all** of them. Empty if none exists up to the filesystem root.
 *
 * All of them, not the first alphabetically, because a split plan is two files side by side in one repo
 * (`DIST-3`) and picking one of them would silently serve half a plan - which is what happened the moment
 * `cloud.apm.yaml` appeared beside `roadmap.apm.yaml`: `yarn apm:check` reported the cloud half and nothing
 * else, cheerfully. A tool that finds a plan by looking around it should find the plan, not a file from it.
 * The same goes for a directory holding both namings, which is one in the middle of moving to the new one.
 *
 * It stops at the first directory with any match rather than collecting up the whole tree, so a nested
 * checkout does not silently absorb its parent's plan. And it never walks above `ceiling`, the repo's root
 * when there is one: a repo without a plan gets one of its own (`resolveStorePaths`) rather than quietly using a
 * plan file that happens to sit in a folder above it.
 *
 * **`attraverso.yaml` comes first, then the rest alphabetically**, so the primary is the new file wherever there
 * is one - which decides only where a project created at runtime lands. Where that matters, name the files
 * with `--store` and the given order wins.
 */
function findStoreUp(start: string, ceiling?: string): string[] {
  for (let dir = start; ; ) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = []; // an unreadable directory just means "keep walking up"
    }
    const matches = names
      .filter(isStoreFile)
      .sort((a, b) => Number(b === STORE_FILE) - Number(a === STORE_FILE) || a.localeCompare(b));
    if (matches.length > 0) return matches.map((name) => join(dir, name));
    const parent = dirname(dir);
    if (dir === ceiling || parent === dir) return []; // reached the repo's root, or the filesystem's
    dir = parent;
  }
}

/** Distinguishes one writer's scratch file from another's. Process id and a counter rather than a random
 *  name, so a stray one left by a crash says who wrote it and roughly when. */
let scratch = 0;

/**
 * Write `text` over `path` atomically (temp + rename), so a reader or a crash never sees a half-written file.
 * This IS the durability: the write is the commit.
 *
 * **The temp path is per-writer** (`IMP-15`). It was a fixed `<path>.tmp`, which meant concurrent saves all
 * wrote the same scratch file and raced the rename: the first consumed it and the rest failed with `ENOENT`.
 * Within one process `createStoreFile` now serialises saves so they cannot overlap at all, but the unique
 * name is still what makes this safe between *two* processes on one file - `IMP-13` refuses that case, and
 * refusing it depends on reading a hash that a foreign writer has not just truncated under us.
 *
 * A failed rename leaves the scratch file behind, so it is removed on the way out. Best-effort: a store that
 * could not be written is the error worth reporting, not the tidying that also failed.
 */
async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${++scratch}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Serialise the database to `path`, atomically. `only` restricts it to those project ids, which is how one
 * file of several is written without the others' projects leaking into it (`IMP-17`); omitted, it is the
 * whole database, which is what a single-file store always wants.
 */
export async function saveStore(db: Database, path: string, only?: ReadonlySet<string>): Promise<string> {
  // The local account's projects, which in file mode is all of them: `insertStore` stamps that owner on
  // everything it imports, and nothing else can create a project in this process. Passing an owner anyway,
  // rather than exporting the table, keeps one rule - a project is reached through its owner or not at all.
  const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);
  const { plan, layouts } = splitLayout(restrict(await exportStore(db, ownerId), only));
  const text = stringifyStore(plan);
  await writeAtomic(path, text);
  // Only when there is a layout to write, so a store with none gets no empty file beside it.
  if (Object.keys(layouts).length > 0) await writeAtomic(layoutPathFor(path), stringifyLayout(layouts));
  return hashOf(text); // so a caller tracking freshness knows exactly what it left on disk
}

/**
 * Each file as the server would write it, keyed by path (`IMP-19`) - the reference `apm:check` holds a
 * committed file to.
 *
 * **Canonical means "what a save would produce", and nothing else.** Not a separate normaliser with its own
 * rules, which would be a second definition of the layout and would drift from the first; this is the save
 * path's own export and partition, so a file that passes is by construction a file the next save leaves
 * alone. That is the property sync needs: an export differs from what is committed only by what changed.
 *
 * Expects every file already imported into `db`, as `apm:check` does - one runtime, as the server holds it.
 */
export async function canonicalForms(db: Database, loaded: { path: string; store: Store }[]): Promise<Map<string, string>> {
  const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);
  const full = await exportStore(db, ownerId);
  return new Map(
    loaded.map(({ path, store }) => [path, stringifyStore(splitLayout(restrict(full, new Set(store.projects.map((p) => p.id)))).plan)]),
  );
}

/** Rewrite a file atomically: temp file, then rename. Exported for `apm:check --fix`, which rewrites a file
 *  exactly as a save would and so should fail exactly as a save would. */
export { writeAtomic };

/** The store narrowed to some project ids, preserving `exportStore`'s order so the result stays deterministic. */
export const restrict = (store: Store, only?: ReadonlySet<string>): Store =>
  only === undefined ? store : { projects: store.projects.filter((project) => only.has(project.id)) };

/** Content hash of the store, as the identity of a particular version of the file. Cheap: these files are
 *  tens of kilobytes and this runs once per mutation, next to a full serialise and a rename. */
const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The hash of what is on disk now, or null if there is no file there. */
async function hashOnDisk(path: string): Promise<string | null> {
  try {
    return hashOf(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * A cheap identity for the file, so the common case - nobody touched it - costs one `stat` and no read.
 *
 * Size rides along with the mtime because a same-millisecond rewrite is not impossible, but neither is the
 * authority here: this only decides whether hashing is worth doing, and the hash decides whether to reload.
 */
async function stampOf(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
}

/**
 * A layout file as read from disk, or null when there is none. Parse failures throw, naming the file: a
 * half-merged layout should fail as loudly as a half-merged plan rather than quietly dropping the map.
 */
async function readLayoutFile(path: string): Promise<{ layouts: LayoutFile; hash: string; stamp: string | null } | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return { layouts: parseLayout(text), hash: hashOf(text), stamp: await stampOf(path) };
  } catch (cause) {
    throw new Error(`${path} is not a layout file: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * Open the store: rebuild the database from the file, or create it empty if this is a first run. Reports which
 * happened, so the caller can say so.
 *
 * Creating it eagerly rather than leaving the first mutation to write it is what makes a fresh install legible:
 * the file exists to be opened, committed or pointed at from the moment the server starts, instead of a path
 * that only materialises once you happen to write something. It cannot scatter stray stores through a tree,
 * because the only paths that reach here without existing are an explicit `--store` (deliberate) and the
 * home-dir fallback; discovery only ever returns a file it just found.
 */
export async function openStore(db: Database, path: string): Promise<{ created: boolean; hash: string }> {
  if (existsSync(path)) {
    const text = await readFile(path, "utf8");
    const layout = await readLayoutFile(layoutPathFor(path));
    await importStore(db, mergeLayout(parseStore(text), layout?.layouts ?? {}));
    return { created: false, hash: hashOf(text) };
  }
  // an empty database serialises to `projects: []`, which loads back cleanly
  return { created: true, hash: await saveStore(db, path) };
}

/**
 * Refuse two store files that hold the same project, by name.
 *
 * Left to the database this surfaces as a unique-index violation naming a column and two uuids, which says
 * nothing about which files are involved - and the files are the only thing that can say. The mistake is a
 * plausible one: copy a plan file to start a second one, forget to re-key it.
 *
 * Shared by every loader rather than owned by `createStoreFile`, because `apm:check` is where a person most
 * likely meets it, and a check that reported the raw constraint error would be the least helpful place for
 * the readable version to be missing.
 */
export function assertDistinctProjects(loaded: { path: string; store: Store }[]): void {
  const seen = new Map<string, string>();
  for (const { path, store } of loaded) {
    for (const project of store.projects) {
      for (const handle of [`key "${project.key}"`, `id ${project.id}`]) {
        const first = seen.get(handle);
        if (first !== undefined && first !== path) {
          throw new Error(`${path} and ${first} both hold project ${handle} - two store files cannot share a project`);
        }
        seen.set(handle, path);
      }
    }
  }
}

/**
 * The store file with the one piece of state that makes writing to it safe: the hash of the version this
 * process last read or wrote (`IMP-13`).
 *
 * **Why a guard is needed at all.** A mutation rewrites the *whole* file, so two processes on one store do not
 * interleave, they overwrite - the later write silently discards everything the other did since it last
 * loaded. That is not hypothetical: on 2026-07-30 two Claude Code windows on one repo destroyed a ticket that
 * had been created, acknowledged and correctly written minutes earlier. Nothing errored, and the window that
 * lost the ticket went on reporting it as present, because it was still in that process's memory.
 *
 * **The fix is on the second writer, not the first.** The bug report's instinct was to confirm the flush
 * before reporting success; that would have changed nothing, since the flush happened and was correct. What is
 * missing is that the *next* process to write never checks whether the file is still the one it read.
 *
 * **This is a guard, not a mutex.** Two processes can still race between the check and the rename, and no
 * amount of checking closes that without a lock (`IMP-13` step 3). It closes the case that actually occurs -
 * writes minutes apart from two windows a person is switching between - and it converts a silent destruction
 * into a refusal, which is the difference that matters.
 *
 * **A refused save leaves the database ahead of the file**, so the error says so plainly. The server cannot
 * quietly reconcile: re-applying an arbitrary mutation onto a reloaded database is not generally possible, and
 * merging two whole-file writes is a merge algorithm over a format git already merges better. What `IMP-10`
 * changed is the ending: `refresh` reloads before the next call does anything, so the process recovers by
 * itself instead of refusing every write until someone reconnects it. The one mutation caught in between is
 * still lost, and the error is what says so.
 *
 * **`refresh` is the other half, and the more important one** (`IMP-10`). The file changes under a running
 * server constantly - a `git pull`, a branch switch, a hand edit, the other window - and a process that keeps
 * answering from the copy it booted with returns wrong answers rather than errors, which for a memory tool is
 * the worst failure shape there is. Checked on read rather than watched: `fs.watch` is inconsistent across
 * platforms and misses exactly the rename-based replacement git does, whereas a check on the read path has no
 * window in which a change can have happened and the check not run.
 */
export interface StoreFile {
  /** The primary store: where a project created at runtime lands, and what the viewer resolves media against. */
  path: string;
  /** Every store file this process loaded, primary first (`IMP-17`). One entry in the ordinary case. */
  paths: string[];
  /** Load the files into `db` (creating an empty one on a first run), remembering what was read. */
  open(db: Database): Promise<{ created: boolean }>;
  /** Rebuild `db` from the files if something else changed one since we last read or wrote it. True if it did. */
  refresh(db: Database): Promise<boolean>;
  /** Serialise `db` over the files, refusing if one is no longer the version we last read or wrote. */
  save(db: Database): Promise<void>;
  /**
   * Append newly recorded measurements to their month files (`METRIC-2`).
   *
   * Separate from `save` on purpose: `save` re-serialises the whole plan, which is exactly what these rows are
   * kept out of. An append costs the new rows and nothing else, and it is why a year of readings does not make
   * recording one number expensive.
   */
  appendMeasurements(records: MeasurementRecord[]): Promise<void>;
}

/**
 * One store file's place in this process: the version it is working from, and which projects came out of it.
 *
 * **`ids` and `keys` are runtime state and are never serialised.** A file that recorded its own path or its
 * own membership would be wrong the moment a checkout moved or a project was migrated between halves of the
 * split, and the file is the source of truth precisely because it holds no facts about its environment.
 */
interface Tracked {
  path: string;
  /** Content hash of the version this process last read or wrote, or null before it has seen one. */
  known: string | null;
  /** `stat` identity of that version, so the untouched case costs one syscall and no read. */
  stamp: string | null;
  /** Project ids this file supplied. */
  ids: Set<string>;
  /** Project keys this file supplied, for routing a measurement to the right month directory. */
  keys: Set<string>;
}

export function createStoreFile(where: string | string[]): StoreFile {
  const files: Tracked[] = (typeof where === "string" ? [where] : where).map((path) => ({
    path,
    known: null,
    stamp: null,
    ids: new Set(),
    keys: new Set(),
  }));
  const primary = files[0];
  // Not reachable through `resolveStorePaths`, which always yields one; a direct caller passing `[]` would
  // otherwise get a store that silently holds nothing.
  if (primary === undefined) throw new Error("a store needs at least one file path");

  const claim = (file: Tracked, store: Store): void => {
    file.ids = new Set(store.projects.map((project) => project.id));
    file.keys = new Set(store.projects.map((project) => project.key));
  };

  /**
   * The layout files (`VIEW-23.2`), one per data folder, with the version this process last read or wrote. Keyed
   * by path rather than hung off each plan file, because two plan files can share a data folder (legacy
   * `*.apm.yaml` side by side share `.apm/`) and so share one layout file.
   */
  const layoutFiles = new Map<string, { known: string | null; stamp: string | null; owners: Tracked[] }>();
  for (const file of files) {
    const path = layoutPathFor(file.path);
    const entry = layoutFiles.get(path) ?? { known: null, stamp: null, owners: [] };
    entry.owners.push(file);
    layoutFiles.set(path, entry);
  }

  /**
   * Read every layout file from disk and lay it over the plans it belongs to, recording what was read. Runs on
   * open and on every rebuild, so the database's layout is always the files' - a branch switch that changes only
   * the map reloads it like any other change.
   */
  const overlayLayouts = async (loaded: { file: Tracked; store: Store }[]): Promise<{ file: Tracked; store: Store }[]> => {
    const out = [...loaded];
    for (const [path, entry] of layoutFiles) {
      const read = await readLayoutFile(path);
      if (read === null) continue; // none yet: whatever the plans carry (an inline layout from before the split) stands
      entry.known = read.hash;
      entry.stamp = read.stamp;
      for (let index = 0; index < out.length; index++) {
        const one = out[index]!;
        if (entry.owners.includes(one.file)) out[index] = { file: one.file, store: mergeLayout(one.store, read.layouts) };
      }
    }
    return out;
  };

  /** Measurements for every store, read once per directory: two plan files committed side by side in one repo
   *  share a `.apm/measurements`, and reading it twice would double every reading it holds. */
  const loadAllMeasurements = async (db: Database): Promise<void> => {
    const dirs = [...new Set(files.map((file) => measurementsDirFor(file.path)))];
    const records: MeasurementRecord[] = [];
    for (const dir of dirs) records.push(...(await readMeasurements(dir)));
    await loadMeasurements(db, records);
  };

  const remember = async (file: Tracked, hash: string): Promise<void> => {
    file.known = hash;
    file.stamp = await stampOf(file.path);
  };

  /**
   * One file operation at a time (`IMP-15`). Both `refresh` and `save` read the files and then update `known`
   * and `stamp` from what they found, and neither is atomic, so overlapping them corrupts the pair.
   *
   * Overlapping saves was the loud half: they used to race one scratch file and fail with `ENOENT`. The quiet
   * half is worse and is why this covers `refresh` too. Between a save's `rename` and its `remember` the file
   * on disk is new while `known` still holds the previous hash, so a refresh landing in that window reads a
   * hash it does not recognise, concludes a foreign process wrote the file, and runs `replaceStore` - clearing
   * the database and rebuilding it from a snapshot that predates any insert committed since. A dropped
   * ticket, no error, nothing to notice.
   *
   * This is reachable in normal use rather than exotic: `guarded` refreshes at the start of every tool call
   * and persists at the end, and Claude Code fans out independent tool calls by design.
   *
   * **Honest about the evidence**: the overlapping-save half is covered by a test that was proved to fail
   * without this. The refresh half is not - the window is a single `stat` wide, and removing the queue while
   * keeping the per-writer temp name leaves every test passing (measured 2026-08-09). Hitting it reliably
   * would need a seam existing only to slow the save down. Kept on the argument rather than the test, because
   * the cost is one promise chain and the failure it prevents is a silently dropped ticket.
   *
   * One queue across every file rather than one each, because `refresh` and `save` both span all of them: a
   * per-file lock would let a save of one interleave with a reload of another, which is the same torn state
   * the queue exists to prevent.
   *
   * A queue rather than a lock, because the work is already promise-shaped. Failures do not poison it - the
   * chain continues either way, and each caller still sees its own outcome.
   */
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    // `work` in both slots so a failure does not poison the chain: the next queued call runs either way,
    // and each caller still gets its own outcome from `run`.
    const run = queue.then(work, work);
    // The no-ops change no ordering whatsoever (verified) - they exist to attach a rejection handler to `run`
    // *now*. Chaining `queue = run` attaches nothing, so `run` stays an orphan until the next call happens to
    // handle it, and if none comes a failure becomes an unhandled rejection, which Node terminates the process
    // for by default. That combination is reachable: an `IMP-13` refusal is an expected failure, this server is
    // long-lived, and one missed `await` on a persist would turn a refused save into a dead server mid-session.
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  return {
    path: primary.path,
    paths: files.map((file) => file.path),

    // Not queued: this runs once at boot, before the server accepts a call, so there is nothing to race.
    async open(db) {
      // Every file is read and parsed before any of it is inserted, so a second store that does not parse
      // fails with nothing loaded rather than with half a plan in the database.
      const loaded: { file: Tracked; store: Store }[] = [];
      for (const file of files) {
        if (!existsSync(file.path)) {
          loaded.push({ file, store: { projects: [] } });
          continue;
        }
        const text = await readFile(file.path, "utf8");
        loaded.push({ file, store: parseStore(text) });
        file.known = hashOf(text);
      }
      assertDistinctProjects(loaded.map(({ file, store }) => ({ path: file.path, store })));

      let created = false;
      for (const { file, store } of await overlayLayouts(loaded)) {
        claim(file, store);
        await importStore(db, store);
      }
      for (const { file } of loaded) {
        // A first run writes the empty file eagerly, for the reason `openStore` gives: a path that only
        // materialises once you happen to write something is not a path you can commit or point at.
        if (file.known === null) {
          created = true;
          await remember(file, await saveStore(db, file.path, file.ids));
        } else {
          file.stamp = await stampOf(file.path);
        }
      }
      // After the plan, always: a measurement names its subject by item ref, so the items have to be there
      // for it to resolve (METRIC-2).
      await loadAllMeasurements(db);
      return { created };
    },

    // Not queued either: an append touches only the month files, which `save` and `refresh` never read or
    // write, so there is nothing here for them to race with.
    async appendMeasurements(records) {
      // Routed by the project key the record already carries, so a reading lands beside the plan that owns
      // its subject. An unrecognised key goes to the primary, which is where its project would have been
      // created moments earlier.
      const byPath = new Map<string, MeasurementRecord[]>();
      for (const record of records) {
        const owner = files.find((file) => file.keys.has(record.project)) ?? primary;
        const dir = measurementsDirFor(owner.path);
        (byPath.get(dir) ?? byPath.set(dir, []).get(dir)!).push(record);
      }
      for (const [dir, rows] of byPath) await appendMeasurements(dir, rows);
    },

    refresh: (db) => exclusive(async () => {
      const fresh = new Map<Tracked, { store: Store; hash: string; stamp: string }>();
      for (const file of files) {
        const current = await stampOf(file.path);
        // Untouched, or gone. A missing file is deliberately **not** a reload: there is nothing to load, and
        // emptying the plan because someone checked out a branch that predates it would be the worst available
        // reading of "the file changed". `save` still refuses, so nothing is written over whatever did that.
        if (current === null || current === file.stamp) continue;

        const text = await readFile(file.path, "utf8");
        const hash = hashOf(text);
        if (hash === file.known) {
          file.stamp = current; // our own write seen again, or a touch that changed no bytes
          continue;
        }
        // Parsed before anything is cleared, and nothing is recorded until every file has parsed: a
        // half-written or badly-merged file must leave the loaded plan intact, and must keep failing on every
        // call rather than once. A server serving a plan it can no longer re-read should say so every time it
        // is asked.
        fresh.set(file, { store: parseStore(text), hash, stamp: current });
      }
      // The layout files by the same test, so a pull that moved only the map still reloads it.
      let layoutMoved = false;
      for (const [path, entry] of layoutFiles) {
        const current = await stampOf(path);
        if (current === null || current === entry.stamp) continue;
        if ((await hashOnDisk(path)) === entry.known) entry.stamp = current;
        else layoutMoved = true;
      }
      if (fresh.size === 0 && !layoutMoved) return false;

      // The runtime holds the *union* of the files, so a change in one rebuilds from all of them. Reloading
      // only the file that moved would mean clearing part of the database, and a partial clear is a second
      // way for the two to disagree; the files are tens of kilobytes, so re-reading them is not worth
      // inventing one for. Files that did not move (or have gone missing) contribute what is already loaded.
      const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);
      const loadedNow = await exportStore(db, ownerId);
      const claimed = new Set(files.flatMap((file) => [...file.ids]));
      const union = await overlayLayouts(
        files.map((file) => {
          const moved = fresh.get(file);
          if (moved !== undefined) return { file, store: moved.store };
          // A project created since the last save belongs to nobody yet; it is the primary's, which is where a
          // save would have put it.
          const mine = loadedNow.projects.filter((p) => file.ids.has(p.id) || (file === primary && !claimed.has(p.id)));
          return { file, store: { projects: mine } };
        }),
      );
      assertDistinctProjects(union.map(({ file, store }) => ({ path: file.path, store })));

      await replaceStore(db, { projects: union.flatMap(({ store }) => store.projects) });
      for (const { file, store } of union) {
        claim(file, store);
        const moved = fresh.get(file);
        if (moved !== undefined) {
          file.known = moved.hash;
          file.stamp = moved.stamp;
        }
      }
      // `clearAll` truncates every table, measurements included, so a reload has to bring them back or a
      // branch switch would silently empty a year of readings that no plan file ever held.
      await loadAllMeasurements(db);
      return true;
    }),

    save: (db) => exclusive(async () => {
      // Every file is checked before any is written: a refusal must leave the whole set as it was, or a
      // mutation spanning two plans would land in one of them and be refused by the other.
      for (const file of files) {
        const current = await hashOnDisk(file.path);
        if (file.known !== null && current !== file.known) {
          const gone = current === null;
          throw new Error(
            `refusing to save: ${file.path} ${gone ? "has been deleted" : "has changed"} since this server loaded it, ` +
              "so writing would overwrite whatever changed it (another apm server, a git checkout, or a hand edit). " +
              "This change was applied in memory but NOT saved. " +
              (gone
                ? "Restore the file, or reconnect the apm server to start a fresh one, then make the change again."
                : "The next call reloads the file, which discards this change, so make it again after that."),
          );
        }
      }

      // Exported once and partitioned, rather than exported per file: one query, and the files cannot
      // disagree about a project that changed between two reads of the database.
      const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);
      const full = await exportStore(db, ownerId);
      const claimed = new Set(files.flatMap((file) => [...file.ids]));
      const layoutsOf = new Map<Tracked, LayoutFile>();
      for (const file of files) {
        const mine = full.projects.filter((p) => file.ids.has(p.id) || (file === primary && !claimed.has(p.id)));
        const { plan, layouts } = splitLayout({ projects: mine });
        layoutsOf.set(file, layouts);
        const text = stringifyStore(plan);
        const hash = hashOf(text);
        // Nothing of this file's changed, so it is not rewritten at all. That is what keeps a mutation to one
        // half of a split plan out of the other half's git history, and it is why `persist()` can stay
        // argumentless: the files work out for themselves which of them a change belonged to. A layout save
        // lands here too, and changes nothing in the plan file, which is the point of the split (`VIEW-23.2`).
        if (hash === file.known) continue;
        await writeAtomic(file.path, text);
        claim(file, { projects: mine });
        await remember(file, hash);
      }

      // The layout files after the plans, by the same skip-if-unchanged rule. **Not guarded like the plan files**,
      // deliberately: a layout is memory the viewer recomputes and saves again whenever it draws, so overwriting a
      // foreign change to it costs a map that settles back on the next save, where a plan overwrite costs work.
      // Refusing would also fail an unrelated tool call over a position, which is the worse trade. `refresh` still
      // reloads a foreign change before the next call, so in practice there is nothing stale to overwrite.
      for (const [path, entry] of layoutFiles) {
        const layouts: LayoutFile = Object.assign({}, ...entry.owners.map((owner) => layoutsOf.get(owner) ?? {}));
        // No layout and no file yet: a store that has never been drawn gets no empty file beside it.
        if (Object.keys(layouts).length === 0 && entry.known === null) continue;
        const text = stringifyLayout(layouts);
        const hash = hashOf(text);
        if (hash === entry.known) continue;
        await writeAtomic(path, text);
        entry.known = hash;
        entry.stamp = await stampOf(path);
      }
    }),
  };
}

/**
 * The store's two side effects with a database already bound, as the transport layer sees them: write through
 * after a mutation, refresh before a read.
 *
 * One value rather than two loose callbacks, so nothing can be handed the ability to write without the ability
 * to notice it is out of date - which is precisely the pair the viewer host and the tool layer each need.
 */
export interface StoreAccess {
  persist(): Promise<void>;
  refresh(): Promise<boolean>;
  /** Append recorded measurements to their month files, without re-serialising the plan (`METRIC-2`). */
  appendMeasurements(records: MeasurementRecord[]): Promise<void>;
}

export const accessTo = (store: StoreFile, db: Database): StoreAccess => ({
  persist: () => store.save(db),
  refresh: () => store.refresh(db),
  appendMeasurements: (records) => store.appendMeasurements(records),
});
