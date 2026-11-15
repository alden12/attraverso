/**
 * Source references (`CTX-13`): where a claim in some prose came from.
 *
 * The text carries a pointer after the claim, `[ref r7k2]`, and `source_references` carries one row per source
 * behind it. Everything here is advisory - nothing a writer does to the prose is refused over a reference - except
 * the one rule the database itself enforces at commit: **a live reference's pointer is in its owner's text**, so a
 * pointer cannot vanish while its reference still claims to stand behind something. The domain keeps that rule
 * true for every tool write by retiring, in the same transaction, the references whose pointers an edit removed;
 * the trigger is the backstop for every other path.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../db/client";
import { sourceReferences } from "../db/schema";
import { timestamp } from "../db/ids";

/**
 * Whether `text` carries the pointer for `key`: `[ref key]`, or the expanded `[ref key: ...]` that `get_item` returns
 * and an agent may send straight back. Matched exactly, so `r7k2` never matches `r7k29` - the same rule as the
 * trigger in migration 0016, which these two must keep agreeing on.
 */
export const hasPointer = (text: string, key: string): boolean => text.includes(`[ref ${key}]`) || text.includes(`[ref ${key}:`);

/** Whose prose a reference sits in: an item's body or a context section's content. */
export type ReferenceOwner = { itemId: string } | { sectionId: string };

/**
 * Retire every live reference of `owner` whose pointer `text` no longer carries, and say which keys they were.
 *
 * Called by every write that replaces an owner's prose, inside its transaction, so the commit-time check finds
 * nothing to object to. Retired rather than deleted: what a claim was once backed by stays legible, and the event
 * for the edit records which references went with it.
 */
export async function retireRemovedPointers(tx: Tx, owner: ReferenceOwner, text: string): Promise<string[]> {
  const ownedBy = "itemId" in owner ? eq(sourceReferences.itemId, owner.itemId) : eq(sourceReferences.sectionId, owner.sectionId);
  const live = await tx.select({ key: sourceReferences.key }).from(sourceReferences).where(and(ownedBy, isNull(sourceReferences.retiredAt)));
  const gone = [...new Set(live.map((row) => row.key))].filter((key) => !hasPointer(text, key)).sort();
  if (gone.length === 0) return [];
  const now = timestamp();
  for (const key of gone) {
    await tx
      .update(sourceReferences)
      .set({ retiredAt: now })
      .where(and(ownedBy, eq(sourceReferences.key, key), isNull(sourceReferences.retiredAt)));
  }
  return gone;
}
