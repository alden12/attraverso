/**
 * Context sections (CTX): the project's living narrative as named prose blocks - "Goals", "Assumptions",
 * "Open questions". An open set of headings, set by heading (so writing one twice revises it in place), with
 * every change captured in the event log rather than a supersede column. This is the durable context a
 * returning session reads, distinct from the one-line `projects.direction` and from the session journal.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { timestamp } from "../db/ids";
import { maybeOne, one } from "../db/rows";
import { contextSections, sourceReferences } from "../db/schema";
import type { OwnedProjectId } from "./owned";
import { mutate, type Actor } from "./events";
import { addSources, liveSources, NO_SOURCES, referenceChanges, retireRemovedPointers, type AddedSource, type ReferenceChange, type SourcesInput } from "./references";
import { bareForm } from "../../scripts/references";

export type ContextSection = typeof contextSections.$inferSelect;

/** The reserved heading for a project's protocol (CTX-9): its session-operating instructions as data, which
 *  `get_project` surfaces first and a session applies before acting. A normal context section, distinguished
 *  only by this heading and by being ordered to the front of the pack. */
export const PROTOCOL_HEADING = "protocol";

/** New sections append after the existing ones, so heading order reflects the order they were introduced. */
async function nextSortOrder(tx: Tx, projectId: OwnedProjectId): Promise<number> {
  const row = maybeOne(
    await tx.select({ max: sql<number | null>`max(${contextSections.sortOrder})` }).from(contextSections).where(eq(contextSections.projectId, projectId)),
  );
  return (row?.max ?? -1) + 1;
}

export interface SetSection {
  projectId: OwnedProjectId;
  heading: string;
  content: string;
  sortOrder?: number;
  /** Place this section immediately after the named one, or at the front when `null` (CTX-11). Resolved to a
   *  `sortOrder` here rather than by the caller - see `orderAfter`. */
  after?: string | null;
  /** Sources for claims in the content, keyed by pointer (`CTX-13`). */
  sources?: SourcesInput;
}

/** The section as written, and what the write did to its sourced claims (`CTX-13`). */
export type SetSectionResult = ContextSection & { referenceChanges: ReferenceChange[]; addedSources: AddedSource[]; clearedSources: string[] };

/**
 * The `sortOrder` that puts a section immediately after `heading` (or first, when `heading` is null).
 *
 * Positions are integers and sections between them are not renumbered, so this returns a value *between* the
 * anchor and whatever follows it. Fractional, deliberately: renumbering the tail on every move is the version
 * that turns a reorder into a write over every section, and gets it wrong under a concurrent edit. The column
 * is an integer today, so this scales the whole project's positions when there is no gap to land in - rare,
 * bounded, and confined to this function.
 *
 * Callers pass a heading because that is the operation people actually have ("put Licensing after Thesis"). An
 * agent handed raw integers picks colliding ones, and recovering from a collision means renumbering, which is
 * a worse problem than the one being solved.
 */
async function orderAfter(tx: Tx, projectId: OwnedProjectId, after: string | null, movingHeading: string): Promise<number> {
  const ordered = (
    await tx
      .select({ heading: contextSections.heading, sortOrder: contextSections.sortOrder })
      .from(contextSections)
      .where(eq(contextSections.projectId, projectId))
      .orderBy(asc(contextSections.sortOrder), asc(contextSections.heading))
  ).filter((s) => s.heading !== movingHeading); // moving a section past itself is a no-op, not a gap to find

  if (after === null) return (ordered[0]?.sortOrder ?? 1) - 1;

  const index = ordered.findIndex((s) => s.heading === after);
  if (index === -1) throw new Error(`no context section "${after}" to place this after`);
  const anchor = ordered[index]!.sortOrder;
  const next = ordered[index + 1]?.sortOrder;
  if (next === undefined) return anchor + 1;
  if (next - anchor > 1) return anchor + Math.floor((next - anchor) / 2);

  // No room between the two: spread every position out so there is, then land in the new gap. Only reachable
  // once sections have been packed tight by repeated inserts, and it is a rewrite of positions only.
  for (const [position, section] of ordered.entries()) {
    await tx
      .update(contextSections)
      .set({ sortOrder: position * 16 })
      .where(and(eq(contextSections.projectId, projectId), eq(contextSections.heading, section.heading)));
  }
  return index * 16 + 8;
}

export async function setSection(db: Database, input: SetSection, actor: Actor): Promise<SetSectionResult> {
  // Pointers are stored bare (`CTX-13`): an expanded `[ref k: ...]` copied from a reply is display, not data.
  const content = bareForm(input.content);
  return mutate(db, actor, async (tx) => {
    const existing = maybeOne(
      await tx.select().from(contextSections).where(and(eq(contextSections.projectId, input.projectId), eq(contextSections.heading, input.heading))),
    );
    const now = timestamp();
    // Precedence: an explicit position, else a requested placement, else keep where it already sits (so
    // revising a section never moves it), else append.
    const order =
      input.sortOrder ??
      (input.after !== undefined
        ? await orderAfter(tx, input.projectId, input.after, input.heading)
        : (existing?.sortOrder ?? (await nextSortOrder(tx, input.projectId))));
    const after = one(
      await tx
        .insert(contextSections)
        .values({ projectId: input.projectId, heading: input.heading, content, sortOrder: order, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [contextSections.projectId, contextSections.heading],
          set: { content, sortOrder: order, updatedAt: now },
        })
        .returning(),
    );
    // As for an item body (`CTX-13`): a reference whose pointer this content no longer carries is retired with it.
    const sourcesBefore = existing ? await liveSources(tx, { sectionId: after.id }) : [];
    const retiredReferences = existing ? await retireRemovedPointers(tx, { sectionId: after.id }, content) : [];
    const { added: addedSources, cleared: clearedSources } =
      input.sources === undefined ? NO_SOURCES : await addSources(tx, input.projectId, { sectionId: after.id }, content, input.sources, actor);
    return {
      result: { ...after, referenceChanges: existing ? referenceChanges(existing.content, content, sourcesBefore) : [], addedSources, clearedSources },
      event: {
        projectId: input.projectId,
        entityType: "context_section",
        entityId: after.id,
        kind: existing ? "updated" : "created",
        before: existing ?? undefined,
        after: {
          ...after,
          ...(retiredReferences.length > 0 ? { retiredReferences } : {}),
          ...(addedSources.length > 0 ? { addedSources } : {}),
          ...(clearedSources.length > 0 ? { clearedSources } : {}),
        },
      },
    };
  });
}

export async function listSections(db: Database, projectId: OwnedProjectId): Promise<ContextSection[]> {
  return db
    .select()
    .from(contextSections)
    .where(eq(contextSections.projectId, projectId))
    .orderBy(asc(contextSections.sortOrder), asc(contextSections.heading));
}

/** Read one section by its exact heading, so a caller can revise it from its current content. */
export async function getSection(db: Database, projectId: OwnedProjectId, heading: string): Promise<ContextSection | null> {
  return maybeOne(
    await db.select().from(contextSections).where(and(eq(contextSections.projectId, projectId), eq(contextSections.heading, heading))),
  );
}

/** Remove a section by heading, logging a `deleted` event with the removed row (so it stays in the audit
 *  trail, never silently dropped). Throws if there is no such section, so a typo does not pass unnoticed. */
export async function deleteSection(db: Database, projectId: OwnedProjectId, heading: string, actor: Actor): Promise<ContextSection> {
  return mutate(db, actor, async (tx) => {
    const existing = maybeOne(
      await tx.select().from(contextSections).where(and(eq(contextSections.projectId, projectId), eq(contextSections.heading, heading))),
    );
    if (existing === null) throw new Error(`no context section "${heading}"`);
    // Its source references go with it (the cascade), so they ride in the event, live and retired alike: deleting a
    // section is how a heading is renamed, and the audit trail is where a rename's sources can be recovered from.
    const references = await tx.select().from(sourceReferences).where(eq(sourceReferences.sectionId, existing.id));
    await tx.delete(contextSections).where(eq(contextSections.id, existing.id));
    return {
      result: existing,
      event: { projectId, entityType: "context_section", entityId: existing.id, kind: "deleted", before: references.length > 0 ? { ...existing, references } : existing },
    };
  });
}
