/**
 * Sweep the throwaway databases the Postgres test target creates (OPS-2).
 *
 * `freshDb()` makes a database per handle and drops it on `close()`. That is not a guarantee: `tools.test.ts`
 * destructures only `{ db }` and never closes, and no per-test discipline survives an interrupted run anyway
 * - a Ctrl-C between create and drop leaks by construction. Left alone they accumulate silently, and the
 * comment in `testing.ts` warning that a leaking run "gets slower every time until someone cleans up by hand"
 * described what the code actually did.
 *
 * So the guarantee lives here instead, where vitest runs it once per run regardless of what any test did:
 * sweep before (clearing a previous run's wreckage) and after (clearing this one's). Fifteen had already
 * accumulated by the time anyone looked.
 *
 * A no-op unless `APM_TEST_PG_URL` is set, so the default PGlite run pays nothing.
 */
import { Pool } from "pg";

/** Only the generated ones: `apm_test_` followed by a bare uuid. Anchored so the *configured* database - very
 *  possibly named `apm_test` - can never match, which is the difference between a sweep and an incident. */
const GENERATED = /^apm_test_[0-9a-f]{32}$/;

async function sweep(url: string): Promise<number> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await pool.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datistemplate = false");
    const stale = rows.map((row) => row.datname).filter((name) => GENERATED.test(name));
    for (const name of stale) {
      // WITH (FORCE) terminates any connection still holding it, which a leaked handle from an interrupted
      // run may well be. Without it the drop fails and the sweep achieves nothing on exactly the runs that
      // needed it most. Postgres 13+, and we pin 17.
      await pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
    return stale.length;
  } finally {
    await pool.end();
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const url = process.env.APM_TEST_PG_URL;
  if (url === undefined || url === "") return async () => {};

  const before = await sweep(url);
  // stderr, not stdout: this is the same process family as a server that must keep stdout to protocol frames,
  // and a vitest reporter owns stdout here regardless.
  if (before > 0) process.stderr.write(`swept ${before} leftover test database(s) from a previous run\n`);

  return async () => {
    await sweep(url);
  };
}
