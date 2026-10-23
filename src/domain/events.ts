/**
 * The event log (DATA-4): every mutation appends one row here, in the same transaction as the change, so an
 * agent editing a project unattended is auditable and reversible. `recordEvent` is called from inside a
 * domain function's transaction, never on its own.
 *
 * `(entityType, entityId)` is the one polymorphic reference the schema reuses to point at any row; it carries
 * no foreign key by necessity, and an event outlives the row it describes. `before`/`after` are opaque JSON
 * the application parses - never queried into with SQL. Locally these rows are later flushed to a separate
 * `events.jsonl`, out of the human-readable plan YAML (IMP-7).
 */
import type { Database, Tx } from "../db/client";
import { events } from "../db/schema";
import type { OwnedProjectId } from "./owned";

/** Who made a change. A plain string for now; a real user id once projects are shared (OPS-4). */
export type Actor = string;

export interface EventInput {
  /** Null only for project creation itself, before a project id exists to scope to. */
  projectId: OwnedProjectId | null;
  entityType: string;
  entityId: string;
  kind: string;
  actor: Actor;
  /** Groups the rows of one domain operation so history and undo act on a unit, not a row. */
  correlationId?: string | null;
  before?: unknown;
  after?: unknown;
}

export async function recordEvent(tx: Tx, event: EventInput): Promise<void> {
  await tx.insert(events).values({
    projectId: event.projectId,
    entityType: event.entityType,
    entityId: event.entityId,
    kind: event.kind,
    actor: event.actor,
    correlationId: event.correlationId ?? null,
    // Serialised here so callers pass plain objects; the column stays opaque text either way.
    before: event.before === undefined ? null : JSON.stringify(event.before),
    after: event.after === undefined ? null : JSON.stringify(event.after),
  });
}

/**
 * Run a mutation in a transaction that MUST produce an event. Every mutating domain function goes through
 * this, which enforces the house rule by construction rather than convention: the body returns its `result`
 * and the `event` to record, so it is impossible to forget the log or to write it outside the transaction.
 * `actor` is threaded in once here, so the body supplies only the rest of the event.
 *
 * One event per call, deliberately: that fits every mutation today (a compound op composes several `mutate`
 * calls). Widen `event` to an array only if a single transaction ever needs to log more than one.
 */
export async function mutate<T>(
  db: Database,
  actor: Actor,
  body: (tx: Tx) => Promise<{ result: T; event: Omit<EventInput, "actor"> }>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const { result, event } = await body(tx);
    await recordEvent(tx, { ...event, actor });
    return result;
  });
}
