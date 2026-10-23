/**
 * Identity and time, both generated in the application rather than the database. Application-side generation
 * lets an id exist before its row is written (so an event can reference an entity created in the same
 * transaction), needs no coordinating sequence when the database goes multi-user, makes tests deterministic
 * by injecting the clock, and - for the YAML-as-source-of-truth model - lets ids and timestamps round-trip
 * through the file verbatim rather than being re-minted or re-formatted by the database.
 */
import { v7 } from "uuid";

/**
 * A UUIDv7: a 48-bit millisecond timestamp followed by randomness, so ids sort by creation time as plain
 * text. That ordering is the reason for v7 over v4: time-ordered keys keep index inserts local, "most recent
 * first" needs no extra column, and it survives the move to a shared cloud database where a coordinating
 * sequence would not. Node's `crypto.randomUUID` only produces v4 (it silently ignores a `{version:7}`
 * option), so this delegates to the `uuid` library rather than hand-rolling the RFC 9562 bit layout.
 *
 * **Call `v7()` with no options unless a specific instant is wanted.** Passing `msecs` opts out of the
 * library's monotonic counter, the thing that keeps two ids minted inside the same millisecond in order.
 * This used to pass `msecs: Date.now()` on every call, which looked equivalent and was not: measured over
 * 500 same-millisecond pairs, ids came out in the wrong order 254 times with an explicit `msecs` and 0 times
 * without. That silently cost the ordering guarantee this whole file exists for - "most recent first needs no
 * extra column" is only true if the id breaks ties correctly - and it surfaced as a rare flake in a notes
 * ordering test, where two notes written in one millisecond tie on `created_at` and fall back to the id.
 *
 * `atMillis` remains injectable so a test can place ids at chosen instants; ordering within one injected
 * millisecond is then the caller's problem, which is fine because such a caller is choosing the instants.
 */
export const uuidv7 = (atMillis?: number): string => (atMillis === undefined ? v7() : v7({ msecs: atMillis }));

/**
 * An instant as fixed-width ISO-8601 UTC text (`2026-07-23T14:47:00.000Z`). Fixed width is the point: the
 * timestamp columns are `text` (see `schema.ts`), compared as strings, so a variable-width format would sort
 * wrongly; and storing the exact string we generated is what lets the YAML export round-trip it verbatim.
 */
export const timestamp = (at: Date = new Date()): string => at.toISOString();

/** Width of one numeric segment in a `sort_path`. Six digits is far past any plausible item count. */
const SEGMENT_WIDTH = 6;

/**
 * The sortable form of a human ref's numeric components: `MCP-3.1.2` becomes `000003.000001.000002`.
 * Zero-padding is what makes lexicographic ordering agree with numeric ordering, so "item 10 after item 2"
 * is a plain `ORDER BY` and "the next child id" is a plain `MAX`, in either dialect and with no
 * string parsing in SQL.
 */
export function sortPath(ref: string): string {
  const numeric = ref.slice(ref.indexOf("-") + 1);
  return numeric
    .split(".")
    .map((segment) => segment.padStart(SEGMENT_WIDTH, "0"))
    .join(".");
}
