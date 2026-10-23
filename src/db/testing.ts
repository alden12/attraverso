/**
 * The test fixture: a fresh database with the schema built from the real drizzle-kit migrations, so tests run
 * against the actual schema rather than a hand-written approximation. A schema mistake fails the tests
 * instead of surfacing on first use.
 *
 * Each call is an isolated database, so tests share nothing and can run in any order.
 *
 * **Two engines behind one function (OPS-2).** By default this is PGlite, matching the local runtime: fast,
 * offline, and what `yarn test` and CI run. Set `APM_TEST_PG_URL` and the identical suite runs against a
 * server Postgres instead (`yarn test:pg`), which is the engine the cloud deploys on.
 *
 * Putting the switch here rather than in a new parallel suite is the whole point: not one test file changes,
 * so the second engine re-runs everything we already assert rather than smoke-testing the few things someone
 * remembered to port. It also means the gap between the engines is measured in failures rather than guessed
 * at - PGlite serialises every statement on a single connection, so the concurrency it has been quietly
 * forgiving shows up as a red test the first time this runs.
 */
import { clearAll, createInMemoryDb, type DbHandle } from "./client";
import { createPostgresDb } from "./postgres";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { ensureUser, LOCAL_IDENTITY } from "../domain/users";

/** A test database plus the account that owns whatever it creates (OPS-4). */
export interface TestDb extends DbHandle {
  /** The local user, provisioned on acquire. Tests pass it explicitly, so they take the scoped path. */
  ownerId: string;
}

/**
 * Idle PGlite engines, reused rather than rebooted.
 *
 * Booting PGlite starts a WASM Postgres, which is ~0.6s locally and ~2.6s on a CI runner. With 64 `freshDb()`
 * calls that was 2m49s of a 5m CI run - 57% of the whole pipeline, and more than the same suite costs against
 * a real server. Truncating every table is milliseconds, and `clearAll` already exists to do exactly that for
 * the `IMP-10` rebuild, so the boot is pure waste.
 *
 * A pool rather than a single shared instance, because six tests in `store.test.ts` deliberately hold two
 * databases at once (the two-writer and external-change cases need two independent servers over one file).
 * With a pool that needs no test to change: the second acquisition simply finds the pool empty and boots.
 *
 * Cleared on **acquire**, not on release, so a test that throws before closing cannot poison the next one.
 * Module state, so each vitest worker gets its own pool and nothing crosses process boundaries.
 */
const idle: DbHandle[] = [];

/**
 * A whole database per handle, rather than a Postgres schema per handle inside one.
 *
 * A namespace would be cheaper, and was the first attempt. It cannot work: drizzle-kit generates its foreign
 * keys schema-qualified (`REFERENCES "public"."projects"`), so replaying the migrations under a different
 * `search_path` creates the tables in the namespace and then points every constraint at a `public` that is
 * empty. Making it work would mean rewriting generated SQL, which is the one thing not to do to migrations.
 *
 * A database each is also the more faithful arrangement, since production puts these tables in `public` too.
 */
const nameFor = (): string => `apm_test_${randomUUID().replaceAll("-", "")}`;

/** Where `CREATE DATABASE` and `DROP DATABASE` are issued from: they cannot run inside the database they act
 *  on, nor inside a transaction, so they get their own short-lived connection to the configured one. */
async function maintenance(url: string, statement: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(statement);
  } finally {
    await pool.end();
  }
}

/** The same server, a different database. */
function urlFor(url: string, database: string): string {
  const target = new URL(url);
  target.pathname = `/${database}`;
  return target.toString();
}

/** A PGlite engine from the pool, emptied, or a newly booted one when the pool is dry. */
async function leasePglite(): Promise<DbHandle> {
  const reused = idle.pop();
  const engine = reused ?? (await createInMemoryDb());
  // Identity included: a pooled engine must start genuinely empty, or one test's accounts are another's.
  if (reused !== undefined) await clearAll(engine.db, { keepIdentity: false });

  // A double `close()` would return the same engine to the pool twice, and two tests would then be handed one
  // database and truncate it under each other. Cheap to make impossible; miserable to debug as flakiness.
  let returned = false;
  return {
    db: engine.db,
    async close() {
      if (returned) return;
      returned = true;
      idle.push(engine);
    },
  };
}

export async function freshDb(): Promise<TestDb> {
  const handle = await acquire();
  // Provisioned here rather than left to each test, because the alternative is a helper that creates projects
  // without an owner - which is the one path production must not have, so it is the one tests must not use.
  const { id } = await ensureUser(handle.db, LOCAL_IDENTITY);
  return { ...handle, ownerId: id };
}

async function acquire(): Promise<DbHandle> {
  const url = process.env.APM_TEST_PG_URL;
  if (url === undefined || url === "") return leasePglite();

  const name = nameFor();
  await maintenance(url, `CREATE DATABASE ${name}`);
  const handle = await createPostgresDb(urlFor(url, name), { migrate: true });

  return {
    db: handle.db,
    async close() {
      // Pool first: Postgres refuses to drop a database anyone is still connected to, and a run that leaks
      // databases gets slower every time until someone cleans up by hand.
      await handle.close();
      await maintenance(url, `DROP DATABASE IF EXISTS ${name}`);
    },
  };
}
