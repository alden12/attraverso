/**
 * The server-Postgres driver, kept in its own module so that **importing it is a choice** (`VIEW-24`, found
 * 2026-08-31).
 *
 * It was in `client.ts` beside the PGlite factory, which is where it belongs conceptually and is wrong
 * mechanically: `runtime.ts` imports that module for `createInMemoryDb`, so `pg` and
 * `drizzle-orm/node-postgres` entered the eager module graph of the **file-backed** path, which never touches
 * them. Under vite-node nothing showed, because Node's ESM interop tolerates it. In the bundled standalone
 * build Rollup's synthetic CommonJS namespace for `pg` self-references before initialisation and the server
 * dies at load with `Cannot access 'pg' before initialization` - so `apm` could not run from the bundle at all,
 * which is how it is meant to be used on a project that is not this one.
 *
 * That is also the error that made `OPS-3` abandon bundling the hosted server, recorded there as "pg cannot be
 * inlined". Too broad: it cannot be inlined *into a path that does not use it*. `runtime.ts` now reaches this
 * module through a dynamic `import()` on the Postgres branch only, so a YAML store never loads it.
 */
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";
import type { DbHandle } from "./client";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

export interface PostgresOptions {
  /**
   * Build the schema on connect. True for tests, where the target starts empty. **False in the cloud**, where
   * migrating from the serving process means every instance racing to upgrade a shared, populated database on
   * deploy - that is a deploy step (`OPS-11`), not a boot step.
   */
  migrate?: boolean;
}

/**
 * A handle onto a server Postgres over `node-postgres` (OPS-2), for the cloud runtime and for running the
 * suite against the same engine we deploy on.
 *
 * The point of the exercise is how little is here. `Database` names the base both drivers share, so this
 * returns the same type `createInMemoryDb` does and nothing downstream can tell them apart. A `Pool` rather
 * than a `Client` because the cloud server is concurrent by nature, and because that concurrency is exactly
 * what PGlite has been hiding: it serialises every statement on one connection, so a read-then-write race is
 * invisible locally and real here.
 */
export async function createPostgresDb(url: string, options: PostgresOptions = {}): Promise<DbHandle> {
  const pool = new Pool({ connectionString: url });
  const db = drizzlePg(pool, { schema });
  if (options.migrate === true) await migratePg(db, { migrationsFolder });
  return { db, close: () => pool.end() };
}

