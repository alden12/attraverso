/**
 * The database handle: Drizzle over an in-memory PGlite (Postgres). This is the disposable query engine the
 * plan YAML is rebuilt into on load and written through on mutation - never durable storage. The same
 * Drizzle schema and queries run on server Postgres in the cloud; only the driver import differs there
 * (`drizzle-orm/node-postgres`), which is the point of adopting Drizzle at the pivot.
 *
 * PGlite boots in ~0.6s (a one-time WASM start), so a handle is created once per process and reused, never
 * per request. The schema is built by running the drizzle-kit migrations against the fresh database - on an
 * empty in-memory database that is simply schema creation, not the durable-data upgrade that "migration"
 * means in the cloud.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { getTableName, is, sql } from "drizzle-orm";
import { PgDatabase, PgTable, type PgQueryResultHKT } from "drizzle-orm/pg-core";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

/**
 * The database, named by what both backends have in common rather than by either driver (OPS-2).
 *
 * `PgliteDatabase` and `NodePgDatabase` both extend `PgDatabase<HKT, TSchema>`, differing only in the
 * higher-kinded type describing the driver's raw result rows. Naming that base here is what lets the whole of
 * `domain/` be written once and run on either: nothing below this file may know which Postgres it is talking
 * to. The `PgQueryResultHKT` parameter is the unparameterised base of that HKT, so both drivers' databases
 * are assignable to this.
 *
 * The only thing the widening costs is the *raw* result shape: `db.execute()` degrades to `unknown`, because
 * that is precisely what the two drivers disagree about in the type system. `rows.ts` absorbs it in one
 * place, which is why the widening was nearly free - it produced two type errors in the twelve files that
 * import this. Everything else survives, including the relational query API (`db.query.items.findMany`),
 * checked rather than assumed on 2026-08-09. We do not use it: every query today goes through the
 * select/insert/update/delete builders or through raw SQL, and no `relations()` are declared in `schema.ts`,
 * so a nested `with` would typecheck and then fail at runtime. Declaring them is a schema decision that has
 * nothing to do with which driver is underneath.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * A "db or transaction" handle, structural so a helper like `recordEvent` or `nextRef` can accept either the
 * database or the `tx` a `db.transaction(...)` callback receives, both of which have these query methods. A
 * property `Pick` rather than `Parameters<Parameters<Database["transaction"]>[0]>[0]`, which extracts the
 * parameter of an overloaded generic method and instantiates far more of Drizzle's transaction type than we
 * need.
 */
export type Tx = Pick<Database, "insert" | "select" | "update" | "delete" | "execute">;

export interface DbHandle {
  db: Database;
  close(): Promise<void>;
}

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

/**
 * A fresh in-memory database with the schema built. Each call is independent, so tests share nothing; in the
 * server this is called once and the handle kept alive for the process.
 */
export async function createInMemoryDb(): Promise<DbHandle> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return {
    db,
    close: () => client.close(),
  };
}

/** Every table in the schema, discovered rather than listed. A hand-maintained list is the kind that goes one
 *  table stale without anything failing, which is exactly the bug `clearAll` must not have. */
const ALL_TABLES = Object.values<unknown>(schema).filter((value): value is PgTable => is(value, PgTable));

/** The tables holding identity rather than plan (`OPS-4`); see `keepIdentity` on `clearAll`. */
const IDENTITY_TABLES = new Set<string>([getTableName(schema.users)]);

/**
 * Empty the database, so it can be rebuilt from a plan file that changed underneath us (IMP-10).
 *
 * `TRUNCATE` rather than a per-table `DELETE`: there is no return value or trigger wanted here, only an empty
 * database, and one statement over all the tables at once sidesteps having to order them by foreign key.
 * `CASCADE` covers the references between them.
 *
 * Takes a `Tx` because the caller must run this and the reload in one transaction - a cleared database with a
 * failed insert behind it is the one state worse than a stale one.
 *
 * `keepIdentity` is required rather than defaulted, because the two callers want opposite things and neither
 * is the obvious one. A **plan reload** keeps it: `users` is not plan data, a changed YAML says nothing about
 * who is running the server, and wiping it would strand the `ownerId` the running process is already holding -
 * re-provisioning mints a *new* id, so every project would go invisible mid-session. A **test fixture** clears
 * it: a reused engine has to start genuinely empty, or one test's accounts are another's.
 */
export async function clearAll(tx: Tx, { keepIdentity }: { keepIdentity: boolean }): Promise<void> {
  const names = ALL_TABLES.map(getTableName)
    .filter((name) => !(keepIdentity && IDENTITY_TABLES.has(name)))
    .map((name) => sql.identifier(name));
  await tx.execute(sql`TRUNCATE TABLE ${sql.join(names, sql`, `)} CASCADE`);
}
