/**
 * Small helpers for reading Drizzle result arrays under `noUncheckedIndexedAccess`, where `rows[0]` and a
 * destructured `[row]` are both `T | undefined`. Insert/update `.returning()` and by-id lookups are meant to
 * produce exactly one row, so collapsing that to `T` (throwing when the assumption is wrong) keeps the call
 * sites honest instead of scattering `!` or `?? throw` everywhere.
 *
 * `rowsOf` is the same idea for raw SQL, and is the single place the two drivers are reconciled (OPS-2).
 */

/** The single row a `.returning()` or unique lookup was meant to produce. Throws on none. */
export function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

/** The first row, or null when there is none. For lookups that legitimately may miss. */
export function maybeOne<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}

/**
 * The rows of a raw `execute()`, typed by the caller.
 *
 * Raw SQL is where the driver seam actually shows. The `Database` type names what PGlite and node-postgres
 * have in common (`PgDatabase<PgQueryResultHKT, ...>`), and at that base `execute()` is typed `unknown`,
 * because the shape of a raw result is precisely what the two drivers disagree about in the type system. They
 * do not disagree at runtime: both return `{ rows }`. So this is the one authorised cast, kept here rather
 * than at each `WITH RECURSIVE` and full-text query, where it would be re-derived slightly differently every
 * time and would have to be revisited driver by driver.
 *
 * The caller names the row type because raw SQL has no schema for us to infer from - the same bargain as
 * `sql<string>` in a select. That is unchecked by construction, so keep raw queries few, which the storage
 * notes already require: CTEs and full-text search only.
 *
 * A result with no `rows` **throws** rather than reading as empty. The version this replaces returned `[]`,
 * and its only caller is the cycle check: an empty result there means "no cycle found", so a driver that ever
 * stopped returning `{ rows }` would not fail, it would quietly let cyclic dependencies through. A driver
 * contract this code cannot verify is exactly the thing that must be loud when it breaks.
 */
export function rowsOf<T>(result: unknown): T[] {
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) throw new Error("raw query returned no `rows`: the database driver is not one this code knows");
  return rows as T[];
}
