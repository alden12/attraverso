/**
 * Attachments (MEDIA-1): images hung off a ticket.
 *
 * The domain owns the *reference* and never the bytes. Storing bytes is the `MediaStore`'s job and reading
 * them back is the transport's, which is what keeps this layer identical whether the blobs are files beside
 * the plan or objects in a bucket.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { maybeOne, one } from "../db/rows";
import { attachments, items } from "../db/schema";
import type { OwnedProjectId } from "./owned";
import { mutate, type Actor } from "./events";

export type Attachment = typeof attachments.$inferSelect;

export interface NewAttachment {
  projectId: OwnedProjectId;
  /** The ticket this belongs to. Optional so a future project-level attachment needs no schema change. */
  ref?: string;
  hash: string;
  mime: string;
  bytes: number;
  caption?: string;
}

/**
 * Record an image against a ticket. The bytes are already in the media store by this point - this writes the
 * reference and nothing else, which is why it can be a plain mutation with an event like any other.
 *
 * Re-attaching the same image to the same ticket returns the existing row rather than failing. The unique
 * index makes it impossible to store twice, and content addressing means it *is* the same picture, so an
 * error would be pedantry: a double-drop on a drop zone should be a no-op, not a red message.
 */
export async function addAttachment(db: Database, input: NewAttachment, actor: Actor): Promise<Attachment> {
  return mutate(db, actor, async (tx) => {
    let itemId: string | null = null;
    if (input.ref !== undefined) {
      const item = maybeOne(
        await tx.select({ id: items.id }).from(items).where(and(eq(items.projectId, input.projectId), eq(items.ref, input.ref))),
      );
      if (item === null) throw new Error(`no ticket "${input.ref}" in this project`);
      itemId = item.id;
    }

    const existing = maybeOne(
      await tx
        .select()
        .from(attachments)
        .where(and(eq(attachments.projectId, input.projectId), eq(attachments.hash, input.hash))),
    );
    if (existing !== null && existing.itemId === itemId) {
      return {
        result: existing,
        event: { projectId: input.projectId, entityType: "attachment", entityId: existing.id, kind: "reattached", after: existing },
      };
    }

    const saved = one(
      await tx
        .insert(attachments)
        .values({
          projectId: input.projectId,
          itemId,
          hash: input.hash,
          mime: input.mime,
          bytes: input.bytes,
          caption: input.caption ?? null,
          actor,
        })
        .returning(),
    );
    return {
      result: saved,
      event: { projectId: input.projectId, entityType: "attachment", entityId: saved.id, kind: "attached", after: saved },
    };
  });
}

/** Attachments on one ticket, oldest first - a plant photographed monthly reads as a sequence, so the natural
 *  order is the order they were taken, not the newest-first a log would use. */
export async function listAttachments(db: Database, projectId: OwnedProjectId, ref?: string): Promise<Attachment[]> {
  const conditions = [eq(attachments.projectId, projectId)];
  if (ref !== undefined) {
    const item = maybeOne(await db.select({ id: items.id }).from(items).where(and(eq(items.projectId, projectId), eq(items.ref, ref))));
    if (item === null) return [];
    conditions.push(eq(attachments.itemId, item.id));
  }
  return db
    .select()
    .from(attachments)
    .where(and(...conditions))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
}

/**
 * Remove an attachment by hash.
 *
 * **The blob is deliberately left on disk.** Another ticket may reference the same bytes, and working out
 * whether one does is a reference count this has no reason to maintain - while the cost of getting it wrong
 * is a photo that silently vanishes from somewhere else. An orphaned blob costs disk and nothing else, and
 * sweeping them is a separate, safely-restartable job.
 */
export async function removeAttachment(db: Database, projectId: OwnedProjectId, hash: string, actor: Actor): Promise<Attachment> {
  return mutate(db, actor, async (tx) => {
    const existing = maybeOne(
      await tx.select().from(attachments).where(and(eq(attachments.projectId, projectId), eq(attachments.hash, hash))),
    );
    if (existing === null) throw new Error(`no attachment ${hash.slice(0, 12)} in this project`);
    await tx.delete(attachments).where(eq(attachments.id, existing.id));
    return {
      result: existing,
      event: { projectId, entityType: "attachment", entityId: existing.id, kind: "detached", before: existing },
    };
  });
}

/** The most recent attachments across a project, for a summary that wants to show something happened without
 *  walking every ticket. */
export async function recentAttachments(db: Database, projectId: OwnedProjectId, limit = 5): Promise<Attachment[]> {
  return db
    .select()
    .from(attachments)
    .where(eq(attachments.projectId, projectId))
    .orderBy(desc(attachments.createdAt), desc(attachments.id))
    .limit(limit);
}
