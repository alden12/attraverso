/**
 * The bundled migrations must be exactly what drizzle would have read from the folder (`DIST-6`): same order,
 * same statements, same hashes. Otherwise a database built from them would differ from one replayed from disk,
 * and `schemaVersion.ts`'s count against the journal would be counting something else.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { bundledMigrations } from "./bundledMigrations";

describe("bundledMigrations", () => {
  it("matches drizzle's own reading of the migrations folder", async () => {
    const fromDisk = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("./migrations", import.meta.url)) });
    expect(fromDisk.length).toBeGreaterThan(0);
    expect(await bundledMigrations()).toEqual(fromDisk);
  });
});
