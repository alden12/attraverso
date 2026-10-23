/**
 * Comments (CTX-2): free prose written down as work happens, optionally attached to an item.
 *
 * Why this exists alongside context sections, which also hold prose. A section is *revised* - you read it,
 * rewrite the whole block, and write it back - which is right for a project's settled narrative and wrong for
 * "the learner reached for the conditional and could not say it". Recording that through a section means a read, a
 * merge and a full rewrite, and an agent in the middle of a task will simply defer it. Deferred writes are
 * lost writes: a Claude Desktop conversation does not end, it gets abandoned. A comment is one append with no
 * read first, cheap enough to write mid-exercise, which is the whole point.
 *
 * **These were called notes until 2026-09-01.** The rename is not cosmetic: it was measured. `add_note` said
 * *"One observation, in a sentence or two"* and across all 64 rows **not one had ever complied** - averaging
 * 2.3kB, and the earliest were already ~1kB, so it was never drift. The cause is a cost asymmetry this module
 * designed on purpose: an append needs no read first, editing an item body does, so when there is something
 * substantial to record the cheap path is a note and the correct path is an edit, and the cheap path wins
 * every time. What was being written was not notes at all - it was **decision records about an item**, which
 * are amendments to that item's reasoning and belong in its body.
 *
 * "Note" is a neutral word that invites anything. "Comment" carries its own shape: it is *about* the thing,
 * secondary to it, and nobody has ever thought a comment replaces the issue it sits on. See `MAX_BODY` for
 * why the word alone was not considered enough.
 *
 * Comments are editable and deletable. The tempting purity is to make them
 * append-only so history stays legible, but that is already true for a different reason: **the event log
 * keeps the before and after of every mutation**, so a corrected or removed comment is still in the audit trail
 * and nothing is actually lost. Refusing to edit would not buy legibility, it would only leave a wrong comment
 * to be re-read by every future session - and a comment written mid-task is exactly the kind of thing that turns
 * out to be wrong or to stop mattering. This is the same reasoning as `deleteSection` in `context.ts`.
 *
 * Revisable durable *facts*, where the supersede chain itself is the interesting record, are a different
 * thing again (`CTX-3`, observations) - which is also why nothing here describes a comment as being "for
 * observations". Two words for two things, one careless description away from colliding.
 */
import { and, count, desc, eq, isNull, like } from "drizzle-orm";
import type { Database } from "../db/client";
import { one } from "../db/rows";
import { comments } from "../db/schema";
import type { OwnedProjectId } from "./owned";
import { mutate, type Actor } from "./events";

export type Comment = typeof comments.$inferSelect;

/** Who a comment is for. `agent` is Claude's own working store: unsurfaced by default, never hidden. */
export const AUDIENCES = ["user", "agent"] as const;
export type Audience = (typeof AUDIENCES)[number];

/**
 * The longest a comment may be, in characters.
 *
 * **A rename alone would not have worked.** `add_note`'s description already said "one observation, in a
 * sentence or two" and was ignored 64 times out of 64; a softer signal will not beat a hard signal that was
 * already disregarded. So the word is backed by a refusal.
 *
 * 800 is picked from the measurement rather than from taste: the existing rows average 2.3kB and none is
 * under 300 characters, so this keeps a real observation - a solid paragraph - and refuses an essay. It will
 * refuse a lot at first, and that is the intent.
 *
 * **A cap only works because there is somewhere to be sent**, which is why the refusal names `edit_item`
 * rather than just saying no: a cap with no destination loses the content instead of relocating it. If what
 * you have to say does not fit, it is almost certainly an amendment to the item's own reasoning, and a body
 * assembled from a chain of appended remarks is exactly the unmaintainable `CLAUDE.md` this project exists to
 * replace.
 *
 * **And it must name *one* destination.** The refusal used to end "Otherwise, shorten it", and what agents
 * observably did was shorten - repeatedly, a little at a time, until it fit. That is this module's own thesis
 * happening to its own refusal: trimming costs one retry, `edit_item` costs a read and an edit, so offering
 * both guarantees the cheap one. The escape hatch is gone, and the message now says outright that trimming
 * keeps the content in the wrong place. Somebody with a genuinely padded remark will still shorten it; the
 * difference is that nothing tells them to.
 *
 * **Deliberately not enforced on import.** `importStore` inserts rows directly, so a plan file holding the 64
 * long comments written before this existed still loads. The cap governs what is *written* from here on, and
 * making it a data constraint would turn a house rule into an unopenable store.
 *
 * **`MAX_PROJECT_BODY` is gone, and so is the exception it stood for (`CTX-15`).** For one day this module
 * carried a looser cap for comments attached to the project rather than an item, on the reasoning that the
 * refusal names `edit_item` and that instruction is meaningless when there is no item. That was an honest
 * stopgap for a problem it had misread: a health-tracking project on the hosted service kept **daily log
 * entries** as project-level comments, one per day at ~750 characters, and those are not comments at all -
 * they are measurements written as prose. `METRIC-2` built the table and the tools they belong in, so the
 * destination now exists and the exception has nothing left to protect.
 */
export const MAX_BODY = 800;

/**
 * The refusal, shared by add and edit so the two cannot drift apart.
 *
 * Two branches, because there are two ways to be over the cap, and **one destination each**. A comment on an
 * item that has outgrown a remark is reasoning belonging to that item. A comment on *no* item cannot be
 * created any more at all, so an over-length one is legacy data and the useful instruction is how to convert
 * it. Neither branch offers trimming as an alternative: see the note on the cap for what happened when one
 * did.
 */
const tooLong = (body: string, itemId: string | null | undefined): Error =>
  new Error(
    itemId != null
      ? `this comment is ${body.length} characters and the limit is ${MAX_BODY}, which means it is not a remark - ` +
        "it is reasoning about the item. Put it in the item itself with edit_item, where a reader will find it. " +
        "Do not cut it down to fit: what survives is the same content in the wrong place, minus what you dropped."
      : `this comment is ${body.length} characters and the limit is ${MAX_BODY}. It is attached to the project rather than ` +
        "to an item, which is no longer allowed: if it holds readings, record them with record_measurements; if it is " +
        "settled prose about the project, move it into a context section with set_context. Then delete this comment.",
  );

/**
 * The refusal that deprecates project-level comments (`CTX-15`).
 *
 * **Unwritable, still readable.** Nothing existing is destroyed or hidden - `list_comments` still returns
 * them and the importer still loads them - because a plan file is committed history and a health tracker's
 * year of entries must not become unopenable over a rule that arrived after they were written.
 *
 * **The refusal is the migration trigger**, which is why it names three destinations rather than saying no.
 * `CTX-2` learned this from the cap: a refusal without a destination loses content instead of relocating it.
 * Converting prose entries into readings is not mechanical - it needs an agent reading each one - so there is
 * no migration script to run, and the moment somebody tries to write the next one is the moment to do it.
 *
 * **No plan ref in the message.** `CTX-15` is a ticket in *this* repo's backlog, and this text is read by an
 * agent working on somebody else's project, where that ref names nothing and is worth going to look for. The
 * ref belongs in this comment, where a maintainer is; the message gets the reason instead. Operator-facing
 * errors (a boot failure, a missing env var) are the exception - the person reading those is deploying this.
 */
const needsAnItem = (): Error =>
  new Error(
    "a comment must be about an item, so give `ref`. If you were recording readings - a weight, macros, " +
      "a duration, a count - use record_measurements, which is what dated data belongs in. If it is settled prose " +
      "about the project, use set_context. Existing project-level comments are still readable with list_comments.",
  );

export interface AddComment {
  projectId: OwnedProjectId;
  body: string;
  /** The item this comment is about. Required since `CTX-15`; already resolved to an id by the caller. */
  itemId?: string | null;
  audience?: Audience;
}

export async function addComment(db: Database, input: AddComment, actor: Actor): Promise<Comment> {
  const audience = input.audience ?? "user";
  if (!AUDIENCES.includes(audience)) throw new Error(`unknown audience "${audience}" (expected ${AUDIENCES.join(" | ")})`);
  const body = input.body.trim();
  if (body === "") throw new Error("a comment needs a body");
  // Checked before the cap, so someone writing a 2kB daily log is told where it belongs rather than told to
  // shorten it - the wrong instruction, and the one that produced 64 essays last time.
  if (input.itemId == null) throw needsAnItem();
  if (body.length > MAX_BODY) throw tooLong(body, input.itemId);

  return mutate(db, actor, async (tx) => {
    const comment = one(
      await tx.insert(comments).values({ projectId: input.projectId, itemId: input.itemId ?? null, body, audience, actor }).returning(),
    );
    return { result: comment, event: { projectId: input.projectId, entityType: "comment", entityId: comment.id, kind: "created", after: comment } };
  });
}

/**
 * How much of a comment's id is shown when comments are listed, and the minimum an edit or delete may name. A full
 * uuid on every line would cost more context than the comments themselves.
 *
 * It is the **last** 8 characters, not the first, and that is not cosmetic: these are UUIDv7, whose leading
 * 48 bits are a millisecond timestamp. Two comments written in the same session share a long common *prefix* -
 * an end-to-end probe had `019fa928` matching two comments a second apart - while the trailing bits are random.
 * So the suffix is where the entropy is, and a prefix scheme would have been ambiguous almost always.
 */
export const SHORT_ID = 8;

/** The printed form of a comment's id, and the only form callers should be shown. */
export const shortCommentId = (id: string): string => id.slice(-SHORT_ID);

/** Resolve a short (or full) id within one project, so `edit_comment`/`delete_comment` can take what was printed.
 *  Ambiguity is an error, never a guess: silently editing the wrong comment is far worse than asking again. */
export async function resolveComment(db: Database, projectId: OwnedProjectId, idSuffix: string): Promise<Comment> {
  const suffix = idSuffix.trim();
  if (suffix.length < SHORT_ID) throw new Error(`comment id "${suffix}" is too short (give at least ${SHORT_ID} characters)`);
  // Anchored at the end, so both the printed short id and a full uuid resolve through the same path (a full
  // id trivially ends with itself). Uuid hex has no `%` or `_` to escape.
  const matches = await db
    .select()
    .from(comments)
    .where(and(eq(comments.projectId, projectId), like(comments.id, `%${suffix}`)))
    .limit(2);
  if (matches.length === 0) throw new Error(`no comment with id ending "${suffix}"`);
  if (matches.length > 1) throw new Error(`"${suffix}" matches more than one comment; give more characters`);
  return one(matches);
}

/** Revise a comment's text. `created_at` deliberately does not move: it records when the thing was observed,
 *  which an edit does not change, and the event log already records when the edit happened. */
export async function editComment(db: Database, projectId: OwnedProjectId, idPrefix: string, body: string, actor: Actor): Promise<Comment> {
  const trimmed = body.trim();
  if (trimmed === "") throw new Error("a comment needs a body");
  const before = await resolveComment(db, projectId, idPrefix);
  // Also on edit, or the cap is one `edit_comment` away from being decorative. Editing a legacy
  // project-level comment stays *allowed* (`CTX-15` deprecates creating them, and destroying what exists was
  // never the point) - it just has to fit, and the refusal tells that caller how to convert it instead.
  if (trimmed.length > MAX_BODY) throw tooLong(trimmed, before.itemId);
  return mutate(db, actor, async (tx) => {
    const after = one(await tx.update(comments).set({ body: trimmed }).where(eq(comments.id, before.id)).returning());
    return { result: after, event: { projectId, entityType: "comment", entityId: after.id, kind: "updated", before, after } };
  });
}

/** Remove a comment. The deleted row rides along in the event, so it stays in the audit trail rather than
 *  vanishing - which is what makes deletion safe to offer at all. */
export async function deleteComment(db: Database, projectId: OwnedProjectId, idPrefix: string, actor: Actor): Promise<Comment> {
  const before = await resolveComment(db, projectId, idPrefix);
  return mutate(db, actor, async (tx) => {
    await tx.delete(comments).where(eq(comments.id, before.id));
    return { result: before, event: { projectId, entityType: "comment", entityId: before.id, kind: "deleted", before } };
  });
}

export interface ListComments {
  projectId: OwnedProjectId;
  /**
   * Which comments to return, and the two absent-ish values mean **different** things:
   * `undefined` is "any", `null` is "only those attached to no item at all".
   *
   * They used to be the same, and `null` quietly meant "any" - which reads as a filter and behaves as no
   * filter, so the one caller who wrote what it looks like would have got every comment in the project back
   * and had no way to tell. Nothing hit it, because the only caller passing `null` meant "any". Distinguished
   * now that project-level comments turn out to be a real population rather than a rounding error (`CTX-15`):
   * on a health-tracking project every daily entry hangs off the project, so "just the log" is the query
   * someone actually wants and there was no way to write it.
   */
  itemId?: string | null;
  audience?: Audience;
  limit?: number;
}

/** Newest first, because the recent ones are what a returning session needs; ties broken by id, which is
 *  UUIDv7 and therefore time-ordered, so two comments written in the same millisecond still order deterministically. */
export async function listComments(db: Database, input: ListComments): Promise<Comment[]> {
  const filters = [eq(comments.projectId, input.projectId)];
  if (input.itemId === null) filters.push(isNull(comments.itemId));
  else if (input.itemId !== undefined) filters.push(eq(comments.itemId, input.itemId));
  if (input.audience !== undefined) filters.push(eq(comments.audience, input.audience));
  return db
    .select()
    .from(comments)
    .where(and(...filters))
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(input.limit ?? 20);
}

/** How many comments a project holds. A count rather than a listing, because `get_project` needs the
 *  number to say what it is not showing (`CTX-4`) and building the rows to read `.length` would be the same
 *  waste as selecting bodies nobody reads. */
export async function countComments(db: Database, projectId: OwnedProjectId): Promise<number> {
  const [row] = await db.select({ n: count() }).from(comments).where(eq(comments.projectId, projectId));
  return row?.n ?? 0;
}
