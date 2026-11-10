/**
 * The drizzle migrations, compiled into the build rather than read off disk (`DIST-6`).
 *
 * drizzle's own `migrate()` reads `migrations/meta/_journal.json` and each `.sql` file with `node:fs` at
 * runtime, which a browser cannot do and which made every packaged artefact carry the folder beside its chunks
 * (`OPS-7`). Here vite inlines the same files as strings at build time (`import.meta.glob` with `?raw`), and
 * this rebuilds exactly the `MigrationMeta[]` drizzle's `readMigrationFiles` would have: the statements split on
 * the same breakpoint marker, the journal's `when` and `breakpoints`, and the sha256 of the file's text. So the
 * applied-migrations table comes out identical to a replay from disk, which `schemaVersion.ts` counts against.
 *
 * Still a replay, not `DATA-15`'s declared schema: that ticket stands, and would replace this module whole.
 *
 * The folder stays on disk for `createPostgresDb`, whose migrations are a deliberate command against a durable
 * database and run in Node only.
 */
import type { MigrationMeta } from "drizzle-orm/migrator";
import journal from "./migrations/meta/_journal.json" with { type: "json" };

/** Each `.sql` file's text, keyed by its path relative to this module (`./migrations/0000_burly_firestar.sql`). */
const files = import.meta.glob<string>("./migrations/*.sql", { query: "?raw", import: "default", eager: true });

/** The breakpoint drizzle-kit writes between statements, and that drizzle's reader splits on. */
const BREAKPOINT = "--> statement-breakpoint";

/** Hex sha256 through Web Crypto, which both Node 22 and a browser have, where `node:crypto` is only the first. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The journal's migrations in order, ready for `PgDialect.migrate`. Throws if the journal names a file the build
 *  does not hold, which is the bundled form of drizzle's "No file ... found" and just as fatal. */
export async function bundledMigrations(): Promise<MigrationMeta[]> {
  return Promise.all(
    journal.entries.map(async (entry) => {
      const text = files[`./migrations/${entry.tag}.sql`];
      if (text === undefined) throw new Error(`migration ${entry.tag} is in the journal but not in the build`);
      return { sql: text.split(BREAKPOINT), bps: entry.breakpoints, folderMillis: entry.when, hash: await sha256(text) };
    }),
  );
}
