/**
 * How the server decides what it is talking to, shared by both entry points (`server.ts` over stdio,
 * `http.ts` over Streamable HTTP).
 *
 * It lives here rather than in `server.ts` because that module calls `main()` at import, so nothing can
 * import from it - including a second entry point and a test. The split is `OPS-3`'s, and it moves no logic:
 * the two arrangements below are exactly as they were.
 */
import { createInMemoryDb, type Database } from "../db/client";
import { requireCurrentSchema } from "../db/schemaVersion";
import { accessTo, createStoreFile, resolveStorePaths, storePathsIn, type StoreAccess } from "../serialise/store";
import { createUnavailableMediaStore } from "../media/store";
import { fileSources, type ViewerSources } from "./viewer";

/**
 * `--store <path>` overrides where the plan lives; otherwise it is auto-discovered (nearest `*.apm.yaml`).
 *
 * Repeatable, because a plan can span several files (`IMP-17`): the first wins where one answer is needed
 * (it is the primary, and where a project created at runtime lands). Collected by scanning rather than
 * reading the one index, so `--store a --store b` and a single `--store` behave the same way.
 */
export const storeArgs = (): string[] | undefined => storePathsIn(process.argv);

/** The primary `--store`, for callers that can only act on one. */
export const storeArg = (): string | undefined => storeArgs()?.[0];

/**
 * The file-backed arrangement, which is the normal one: the YAML is the source of truth, PGlite is a
 * disposable query engine rebuilt from it on boot and written through on every mutation.
 *
 * A missing file is a first run, so the store is created empty rather than treated as an error - the launcher
 * (Claude Desktop) gives us no cwd to discover one from, and an install that has never been written to should
 * still have a file at a knowable path. Through a StoreFile rather than openStore/saveStore directly, so the
 * process remembers which version of the file it is working from and refuses to write over a newer one
 * (IMP-13), and both directions are bound to this database so a `git pull` or branch switch under a
 * long-lived process is picked up rather than silently ignored (IMP-10).
 */
export async function fileBacked(): Promise<Runtime> {
  const { db } = await createInMemoryDb();
  const store = createStoreFile(resolveStorePaths(storeArgs()));
  const { created } = await store.open(db);
  return {
    db,
    access: accessTo(store, db),
    // Media resolves against the primary store, which is also where a project created at runtime lands.
    sources: fileSources(store.path),
    describe: `store: ${store.paths.join(", ")}${created ? ", created" : ""}`,
  };
}

/**
 * The database-backed arrangement (`APM_DATABASE_URL`): Postgres is the source of truth and there is **no
 * YAML at all**. This is `OPS-11` inverted into place locally, deliberately without any of the rest of it -
 * no HTTP transport (`OPS-3`), no auth (`OPS-10`), no object storage. It exists so the persistence inversion
 * can be exercised over the transport we already trust.
 *
 * The write-through is not ported, it is switched **off**: `persist` does nothing because the transaction
 * already committed to the durable copy, and `refresh` returns false because there is no file to have changed
 * underneath us. That is the whole of the mode, which is what the `StoreAccess` seam was for.
 *
 * **It does not migrate**, decided 2026-08-28. `createPostgresDb` defaults `migrate` to false and this takes
 * the default: instances would otherwise race to upgrade a shared database on deploy, and under scale-to-zero
 * (`OPS-3`) a machine boots on every wake, so it would also pay that cost on the cold start that lands on
 * `get_project`. `yarn migrate:cloud` is the explicit command, and `requireCurrentSchema` refuses to
 * serve a database that has not had it - unmigrated or merely behind - rather than failing later on the
 * first query that wanted a column nobody added.
 *
 * **Uploads are refused**, decided 2026-08-28. Blobs used to go to a local directory, which is fine for one
 * machine and wrong on a host whose filesystem is ephemeral, where an upload would work and then vanish on the
 * next deploy. Object storage is the eventual answer and is deliberately not half-built in the meantime, so
 * this fails honestly instead. `APM_MEDIA_DIR` no longer applies in this mode.
 */
export async function databaseBacked(url: string): Promise<Runtime> {
  // Dynamic, so `pg` and `drizzle-orm/node-postgres` never enter the file-backed path's module graph. That is
  // not a size optimisation: statically importing them broke the bundled build outright, because Rollup's
  // CommonJS namespace for `pg` self-references before initialisation. See `db/postgres.ts`.
  const { createPostgresDb } = await import("../db/postgres");
  const { db } = await createPostgresDb(url);
  const warning = await requireCurrentSchema(db);
  if (warning !== null) process.stderr.write(`warning: ${warning}\n`);
  return {
    db,
    // Both no-ops for the same reason, and `appendMeasurements` joins them: in database mode the write
    // has already committed, so there is nothing to persist, no file to have changed underneath us, and
    // no month file for a measurement to be appended to (`OPS-11`, `METRIC-2`).
    access: { persist: async () => {}, refresh: async () => false, appendMeasurements: async () => {} },
    sources: {
      media: createUnavailableMediaStore("uploads are not available in cloud mode yet - this deployment has no object storage (OPS-11)"),
      storePath: null,
    },
    // The URL is logged without its credentials: stderr goes to Claude Desktop's log file, which is not a
    // place to leave a database password.
    describe: `database: ${redact(url)} (no plan file; uploads disabled)`,
  };
}

export interface Runtime {
  db: Database;
  access: StoreAccess;
  sources: ViewerSources;
  describe: string;
}

/** A connection string with any password removed, for logging. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== "") parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<unparseable connection string>";
  }
}
