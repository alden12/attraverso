/**
 * drizzle-kit config. `schema.ts` is the single source; drizzle-kit generates the migrations under
 * `src/db/migrations`. The same generated SQL builds the fresh in-memory PGlite schema on load locally
 * (via the migrator in `client.ts`) and upgrades the server Postgres database in the cloud.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
});
