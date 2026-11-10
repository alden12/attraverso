/**
 * A fresh in-memory PGlite database with the schema built: the disposable query engine of `client.ts`'s header,
 * which the plan YAML is rebuilt into on load.
 *
 * Its own module, apart from `client.ts`, because it compiles the migrations in (`bundledMigrations.ts`, so it
 * runs in a browser, `DIST-6`) and that uses `import.meta.glob`, which exists only under vite's transform. The
 * viewer's `vite.config.ts` reaches `client.ts` through `serialise/store.ts`, and esbuild loads that config
 * without vite's transform, so the glob must not be on that path. A lazy import would dodge it too, but vite-node
 * closes its module server once the entry finishes evaluating, and the stdio server's `main()` is not awaited,
 * so an import that late is refused.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { PgDialect, type PgSession } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { bundledMigrations } from "./bundledMigrations";
import type { DbHandle } from "./client";

/**
 * A fresh in-memory database with the schema built. Each call is independent, so tests share nothing; in the
 * server this is called once and the handle kept alive for the process.
 */
export async function createInMemoryDb(): Promise<DbHandle> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  // `PgDialect.migrate` is what drizzle's pglite `migrate()` calls once it has read the files; the config only
  // names the bookkeeping table, so the folder it asks for is never opened. The cast is the one drizzle's own
  // migrator makes: `migrate` is typed against a schema-less session, and ours carries a schema.
  await new PgDialect().migrate(await bundledMigrations(), db._.session as unknown as PgSession, { migrationsFolder: "(bundled)" });
  return {
    db,
    close: () => client.close(),
  };
}
