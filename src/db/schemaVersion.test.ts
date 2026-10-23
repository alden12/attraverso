/**
 * The boot check that stands in for a deploy step (OPS-11).
 *
 * Uses `createInMemoryDb` directly rather than the shared `freshDb` fixture, deliberately: these tests
 * mutate `drizzle.__drizzle_migrations`, which `clearAll` does not reset because it only knows the
 * application's own tables. Against a pooled engine (PLAT-6) that damage would leak into whichever test
 * leased it next. One extra WASM boot is the cheap price of not doing that.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { createInMemoryDb, type DbHandle } from "./client";
import { EXPECTED_MIGRATIONS, requireCurrentSchema } from "./schemaVersion";

describe("requireCurrentSchema (OPS-11)", () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle = await createInMemoryDb();
  });
  afterEach(async () => {
    await handle.close();
  });

  it("passes silently on a database built by this build", async () => {
    await expect(requireCurrentSchema(handle.db)).resolves.toBeNull();
  });

  it("names the command when the database has never been migrated", async () => {
    await handle.db.execute(sql`DROP SCHEMA drizzle CASCADE`);
    await expect(requireCurrentSchema(handle.db)).rejects.toThrow("has no apm schema");
  });

  /** The case the first version of this check could not see, and the one that actually bites in ongoing
   *  operation: tables exist, so a presence check passes, but a column this build queries does not. */
  it("refuses a database that is merely behind, counting how far", async () => {
    await handle.db.execute(sql`DELETE FROM drizzle.__drizzle_migrations WHERE id IN (SELECT id FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1)`);
    await expect(requireCurrentSchema(handle.db)).rejects.toThrow(
      `1 migration behind this build (${EXPECTED_MIGRATIONS - 1} applied, ${EXPECTED_MIGRATIONS} expected)`,
    );
  });

  /** Ahead is a straggler process during a rolling deploy, not a broken one: a migration that adds things
   *  leaves older code working, and refusing would turn a routine deploy into an outage. */
  it("warns but still serves when the database is ahead of this build", async () => {
    await handle.db.execute(sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('future', 9999999999999)`);
    await expect(requireCurrentSchema(handle.db)).resolves.toContain("ahead of this build");
  });
});
