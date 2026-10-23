/**
 * Is this durable database the one this build was written against? (`OPS-11`)
 *
 * Only cloud mode asks. Locally there is nothing to be out of step with: PGlite is built from the migrations
 * at boot and filled from the YAML, so the schema is the current one by construction (`DATA-15` will build it
 * more directly still, which does not change this).
 *
 * The question exists *because* migrating became an explicit command. Making it manual is right - instances
 * would otherwise race to upgrade one shared database on deploy - but it creates a state nothing previously
 * could reach: code running against a database that has not been brought with it. Left unasked, that surfaces
 * as a missing table or column from whichever tool the user happened to call first, which points at the tool
 * rather than at the deploy step nobody ran.
 *
 * The expected count comes from drizzle's own journal, imported rather than read from disk so it is inlined
 * into the bundle and cannot be the thing that is missing (`OPS-1` counts every runtime file dependency).
 */
import { sql } from "drizzle-orm";
import journal from "./migrations/meta/_journal.json" with { type: "json" };
import { rowsOf } from "./rows";
import type { Database } from "./client";

/** How many migrations this build expects a database to have applied. */
export const EXPECTED_MIGRATIONS = journal.entries.length;

/**
 * Throw unless the database is at least at this build's schema. Returns a warning to log, or null.
 *
 * **Behind is fatal, ahead is only a warning**, which is the asymmetry worth understanding. Behind means a
 * column this code queries may not exist, so serving would produce errors that read as bugs. Ahead means the
 * database has been upgraded by a newer deploy and this process is the straggler - it is very likely fine,
 * because a migration that only adds things leaves older code working, and refusing would turn a routine
 * rolling deploy into an outage. Say it loudly and keep serving.
 */
export async function requireCurrentSchema(db: Database): Promise<string | null> {
  const built = rowsOf<{ present: boolean }>(
    await db.execute(sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`),
  );
  if (built[0]?.present !== true) {
    throw new Error("this database has no apm schema - run `yarn migrate:cloud` against it first (OPS-11)");
  }

  const counted = rowsOf<{ applied: number }>(
    await db.execute(sql`SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations`),
  );
  const applied = counted[0]?.applied ?? 0;

  // Counted rather than compared by name, because drizzle's table records a hash and a timestamp per applied
  // migration, and the journal is append-only: n rows means the first n entries. A name-by-name check would
  // be stricter and is not worth the coupling to a table another tool owns.
  if (applied < EXPECTED_MIGRATIONS) {
    const behind = EXPECTED_MIGRATIONS - applied;
    throw new Error(
      `this database is ${behind} migration${behind === 1 ? "" : "s"} behind this build ` +
        `(${applied} applied, ${EXPECTED_MIGRATIONS} expected) - run \`yarn migrate:cloud\` against it first (OPS-11)`,
    );
  }
  if (applied > EXPECTED_MIGRATIONS) {
    return `this database is ahead of this build (${applied} applied, ${EXPECTED_MIGRATIONS} expected): it has been migrated by a newer deploy, and this process is the straggler`;
  }
  return null;
}
