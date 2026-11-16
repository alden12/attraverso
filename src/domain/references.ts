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
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { sourceReferences } from "../db/schema";
import { timestamp } from "../db/ids";
import { normaliseClaim, parseCodeRef, parsePointers } from "../../scripts/references";

/**
 * Whether `text` carries the pointer for `key`: `[ref key]`, or the expanded `[ref key: ...]` that `get_item` returns
 * and an agent may send straight back. Matched exactly, so `r7k2` never matches `r7k29`. This is the trigger's own
 * test in migration 0016, restated for anything that must agree with what the database will accept; deciding which
 * pointers a text holds is `parsePointers`'s job.
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
  // The shared parser decides what is still pointed at, not a substring search, so a pointer pasted into a code span
  // counts as gone here exactly as it does in `apm:check` and the viewer. (The trigger's substring test is looser,
  // which is the safe direction: it is the backstop for existence, and this is what decides.)
  const pointed = new Set(parsePointers(text).pointers.map((p) => p.key));
  const gone = [...new Set(live.map((row) => row.key))].filter((key) => !pointed.has(key)).sort();
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

/** Where a claim's source can come from. `agent` is the default for anything unreferenced and is never written. */
export const SOURCE_KINDS = ["user", "test", "search", "docs", "code"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** A source to add: the kind, and its detail - the command, URL or file, or for `user` the words verbatim. */
export interface NewSource {
  source: SourceKind;
  detail: string;
}

/** Sources to add, keyed by the pointer the writer put after each claim; `null` clears a key's sources (`CTX-17.2`). */
export type SourcesInput = Record<string, NewSource | NewSource[] | null>;

/** One source as a reader needs it. */
export interface ReferenceSource {
  key: string;
  source: string;
  detail: string;
  quotedText: string;
  recordedAt: string;
  /**
   * The last time anyone in the project cited this same source (kind and detail) for any claim, retired ones
   * included (`CTX-17.5`). A source is its kind and detail, so this is derived from the rows rather than stored on a
   * source of its own: citing a guide for a new claim says the guide still exists and was read then. It is **not**
   * a re-check of this claim, which is `recordedAt`'s; a reader is shown both when they differ.
   */
  checkedAt: string;
}

/** One source as `addSources` recorded it, for the writing event's payload and the writer's reply. */
export interface AddedSource {
  key: string;
  source: string;
  detail: string;
  /** This key already had this very source, so the new citation replaced it: a re-check (`CTX-17.2`). */
  replaced?: true;
  /** How many other live claims in the project cite the same source: reuse, which the reply names (`CTX-17.5`). */
  alsoBehind?: number;
}

/** What `addSources` did: the sources it recorded, and the keys whose sources it cleared. */
export interface SourcesWritten {
  added: AddedSource[];
  cleared: string[];
}

/** A write that gave no sources. */
export const NO_SOURCES: SourcesWritten = Object.freeze({ added: [], cleared: [] }) as SourcesWritten;

/** A different advisory-lock namespace from ref allocation's, so the two never queue behind each other. */
const REFERENCE_LOCK = 7_172_013;

/**
 * Add sources to the references in `text`, after it has been written, inside the writing transaction.
 *
 * Each key must have its pointer in the text, once - the source stands behind *that* claim, and records the text it
 * covers now as what it vouched for - and must not be live under another owner. Serialised per project by an
 * advisory lock, because "one key, one owner" is a read-then-write: under READ COMMITTED two writers giving one
 * key to different items at once would both pass the check (found in the `CTX-13` spike, the same race `OPS-2`
 * fixed for ref allocation). The commit-time trigger would still refuse the second, but as a bare failure; the
 * lock turns it into a named one.
 *
 * **A source is its kind and its detail** (`CTX-17.5`), so the same guide cited behind fifty claims is one source:
 * nothing to declare first, and each claim still records its own text and date, so "text changed since" stays per
 * claim. Two consequences (`CTX-17.2`): citing a source a key already has **replaces** that citation (the old row is
 * retired, the new one records the claim as it reads now), so a re-check never piles up beside the stale one; and
 * `null` for a key **clears** its sources, retiring every live one, so a source that turned out wrong can go.
 */
export async function addSources(
  tx: Tx,
  projectId: string,
  owner: ReferenceOwner,
  text: string,
  sources: SourcesInput,
  actor: string,
): Promise<SourcesWritten> {
  const keys = Object.keys(sources);
  if (keys.length === 0) return { added: [], cleared: [] };
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${REFERENCE_LOCK}, hashtext(${projectId}))`);
  const { pointers } = parsePointers(text);
  const covers = new Map(pointers.map((p) => [p.key, p.covers]));
  const ownerId = "itemId" in owner ? owner.itemId : owner.sectionId;
  const ownedBy = "itemId" in owner ? eq(sourceReferences.itemId, owner.itemId) : eq(sourceReferences.sectionId, owner.sectionId);
  const now = timestamp();
  const rows: (typeof sourceReferences.$inferInsert & { replaced?: true })[] = [];
  const cleared: string[] = [];
  for (const key of keys) {
    const given = sources[key];
    if (given === null || given === undefined) {
      const gone = await tx
        .update(sourceReferences)
        .set({ retiredAt: now })
        .where(and(ownedBy, eq(sourceReferences.key, key), isNull(sourceReferences.retiredAt)))
        .returning({ id: sourceReferences.id });
      if (gone.length === 0) throw new Error(`[ref ${key}] has no sources here to clear`);
      cleared.push(key);
      continue;
    }
    const claim = covers.get(key);
    if (claim === undefined) {
      // Written but not read as a pointer is a different mistake from not written, and saying "not in the text" about
      // text that plainly holds it sends the writer looking in the wrong place (`CTX-17.3`).
      if (hasPointer(text, key)) {
        throw new Error(
          `[ref ${key}] is in the text but is not read as a pointer: it is inside code, escaped, or followed by "(" (a link) or, at the start of a line, ":" (a link definition)`,
        );
      }
      throw new Error(`no [ref ${key}] in the text: write it straight after the claim it stands behind, as [ref ${key}]`);
    }
    // Twice in one text, a source could only vouch for one of the claims, and which one would be an accident of the
    // parser's order: it bound to the last, so the first, usually the one meant, read "text changed since" at once
    // (`CTX-17.1`). Refused rather than warned, like a missing pointer, because the source would record the wrong claim.
    if (pointers.filter((p) => p.key === key).length > 1) {
      throw new Error(`[ref ${key}] appears more than once: a key stands behind one claim, so give each claim its own key (${key}a, ${key}b, ...)`);
    }
    if (claim === "") throw new Error(`[ref ${key}] has no claim before it: put it straight after the sentence it stands behind`);
    const elsewhere = await tx
      .select({ itemId: sourceReferences.itemId, sectionId: sourceReferences.sectionId })
      .from(sourceReferences)
      .where(and(eq(sourceReferences.projectId, projectId), eq(sourceReferences.key, key), isNull(sourceReferences.retiredAt)));
    if (elsewhere.some((row) => (row.itemId ?? row.sectionId) !== ownerId)) {
      throw new Error(`reference ${key} already stands behind a claim elsewhere in this project: choose another key`);
    }
    for (const source of [given].flat()) {
      if (!(SOURCE_KINDS as readonly string[]).includes(source.source)) {
        throw new Error(`"${source.source}" is not a source: use one of ${SOURCE_KINDS.join(", ")} (unreferenced text is your own reasoning)`);
      }
      const detail = source.detail.trim();
      if (detail === "") throw new Error(`a ${source.source} source needs its detail: the command, URL or file, or the user's words verbatim`);
      if (source.source === "code" && parseCodeRef(detail) === null) {
        throw new Error(`"${detail}" is not a code reference: write path:line or path:from-to, optionally :column, then @commit, e.g. src/db/schema.ts:120-140@345a746`);
      }
      // The same source given twice in one call is one citation, not two.
      if (rows.some((row) => row.key === key && row.source === source.source && row.detail === detail)) continue;
      const replaced = await tx
        .update(sourceReferences)
        .set({ retiredAt: now })
        .where(and(ownedBy, eq(sourceReferences.key, key), eq(sourceReferences.source, source.source), eq(sourceReferences.detail, detail), isNull(sourceReferences.retiredAt)))
        .returning({ id: sourceReferences.id });
      rows.push({
        projectId,
        key,
        itemId: "itemId" in owner ? owner.itemId : null,
        sectionId: "sectionId" in owner ? owner.sectionId : null,
        source: source.source,
        detail,
        quotedText: claim,
        actor,
        recordedAt: now,
        ...(replaced.length > 0 ? { replaced: true as const } : {}),
      });
    }
  }
  if (rows.length > 0) await tx.insert(sourceReferences).values(rows.map(({ replaced: _replaced, ...row }) => row));
  const added: AddedSource[] = [];
  for (const row of rows) {
    // Other live claims citing this same source, so the reply can say it was reused rather than new.
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sourceReferences)
      .where(
        and(
          eq(sourceReferences.projectId, projectId),
          eq(sourceReferences.source, row.source),
          eq(sourceReferences.detail, row.detail),
          isNull(sourceReferences.retiredAt),
          sql`${sourceReferences.key} <> ${row.key}`,
        ),
      )) as [{ n: number }];
    added.push({ key: row.key, source: row.source, detail: row.detail, ...(row.replaced ? { replaced: true as const } : {}), ...(n > 0 ? { alsoBehind: n } : {}) });
  }
  return { added: added.sort((a, b) => a.key.localeCompare(b.key)), cleared: cleared.sort() };
}

/** The live sources behind an owner's references, oldest first within each key. */
export async function liveSources(db: Database | Tx, owner: ReferenceOwner): Promise<ReferenceSource[]> {
  const ownedBy = "itemId" in owner ? eq(sourceReferences.itemId, owner.itemId) : eq(sourceReferences.sectionId, owner.sectionId);
  return db
    .select({
      key: sourceReferences.key,
      source: sourceReferences.source,
      detail: sourceReferences.detail,
      quotedText: sourceReferences.quotedText,
      recordedAt: sourceReferences.recordedAt,
      // Correlated, and only over this owner's few rows: the last citation of the same source anywhere in the project.
      // Qualified by hand, since drizzle leaves a one-table select's columns bare and they would bind to `cited`.
      checkedAt: sql<string>`(SELECT max(cited.recorded_at) FROM source_references cited WHERE cited.project_id = source_references.project_id AND cited.source = source_references.source AND cited.detail = source_references.detail)`,
    })
    .from(sourceReferences)
    .where(and(ownedBy, isNull(sourceReferences.retiredAt)))
    .orderBy(asc(sourceReferences.key), asc(sourceReferences.recordedAt), asc(sourceReferences.id));
}

/** A command, a file or a URL longer than this is left out of an expanded pointer: a cut one is noise. */
const SHORT_DETAIL = 40;
/** A user's words past this are cut, with an ellipsis, rather than dropped: the quote is the evidence. */
const QUOTE_SHOWN = 100;

/**
 * How much of a source's detail an expanded pointer shows by default, by kind (`CTX-16`). One length for all of
 * them hid what made a source useful: every `code` location (45 to 60 characters below `packages/`) and most of
 * the user's words, so a reader saw "code 2026-11-16" and not which file. So a code location always shows, being
 * short enough and the most checkable detail there is; a quote shows up to `QUOTE_SHOWN`, cut at a word; anything
 * else only when it fits whole. `references: "full"` shows every detail in full.
 */
function detailShown(source: string, detail: string): string | null {
  if (source === "code") return detail;
  if (source === "user") {
    if (detail.length <= QUOTE_SHOWN) return `"${detail}"`;
    const cut = detail.slice(0, QUOTE_SHOWN);
    return `"${cut.slice(0, Math.max(cut.lastIndexOf(" "), QUOTE_SHOWN / 2)).trimEnd()}..."`;
  }
  return detail.length <= SHORT_DETAIL ? detail : null;
}

/**
 * A detail as an expanded pointer shows it. Display only, so it is made safe for the round trip rather than kept
 * exact: an agent sends a body it read straight back, and `bareForm` must find where each expansion ends. A `]` or
 * a line break would end it early, and a backtick would open a code span that hides what follows; brackets become
 * parentheses, backticks quotes, and line breaks spaces. The stored detail is untouched.
 */
const shown = (detail: string): string => detail.replace(/\s*[\r\n]+\s*/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").replace(/`/g, "'");

/**
 * The text a reader is given: every pointer expanded in place with its sources, so an agent sees where a claim
 * came from beside the claim, at the moment it reads it, without another call. Never stored - writing reduces it
 * back with `bareForm` - and in the reply only.
 *
 * `[ref r7k2: search 2026-08-10, test 2026-08-13 yarn cloud:check, text changed since]` - each source's kind and
 * date, as much of its detail as `detailShown` gives its kind (all of it, with `full`), `text changed since` when a source vouched for words the
 * claim no longer says, and `code changed since` when a `code` source's lines are in `codeChanged`. A pointer with
 * nothing behind it says so, rather than passing as backed.
 */
export function expandPointers(text: string, sources: ReferenceSource[], full = false, codeChanged: ReadonlySet<string> = new Set()): string {
  const byKey = new Map<string, ReferenceSource[]>();
  for (const s of sources) byKey.set(s.key, [...(byKey.get(s.key) ?? []), s]);
  const { pointers } = parsePointers(text);
  let out = "";
  let last = 0;
  for (const p of [...pointers].sort((a, b) => a.at - b.at)) {
    const behind = byKey.get(p.key) ?? [];
    const parts = behind.map((s) => {
      const detail = full ? (s.source === "user" ? `"${shown(s.detail)}"` : shown(s.detail)) : detailShown(s.source, shown(s.detail));
      const head = detail === null ? `${s.source} ${s.recordedAt.slice(0, 10)}` : `${s.source} ${s.recordedAt.slice(0, 10)} ${detail}`;
      // Cited again since, for another claim (`CTX-17.5`): the source is alive and was read then, but this claim was
      // not re-checked, so both dates show and an agent can tell a quick look would bring this one level.
      const rechecked = s.checkedAt.slice(0, 10);
      return rechecked > s.recordedAt.slice(0, 10) ? `${head} (source rechecked ${rechecked})` : head;
    });
    if (behind.length === 0) parts.push("no reference behind it");
    // Against the newest source only: adding a source for the claim's new wording is what clears it.
    else if (normaliseClaim(behind[behind.length - 1]!.quotedText) !== p.covers) parts.push("text changed since");
    // Only where a checkout could tell (see `mcp/codeDrift.ts`): the lines a `code` source pinned differ from the file now.
    if (behind.some((s) => s.source === "code" && codeChanged.has(s.detail))) parts.push("code changed since");
    out += text.slice(last, p.at) + `[ref ${p.key}: ${parts.join(", ")}]`;
    last = p.at + p.written.length;
  }
  return out + text.slice(last);
}

/** What an edit did to one sourced claim, for the writer's reply. */
export type ReferenceChange =
  | { key: string; kind: "changed"; sources: string; before: string; after: string; moved?: true }
  | { key: string; kind: "retired"; sources: string };

/**
 * The sourced claims an edit touched, old text against new, so the writer sees them in the same reply rather than
 * finding out on the next read. Nothing is refused: a changed claim keeps its sources and will read "text changed
 * since"; a removed pointer has already been retired.
 */
export function referenceChanges(before: string, after: string, sources: ReferenceSource[]): ReferenceChange[] {
  const was = new Map(parsePointers(before).pointers.map((p) => [p.key, p.covers]));
  const { pointers } = parsePointers(after);
  const now = new Map(pointers.map((p) => [p.key, p.covers]));
  // The new text with its pointers taken out, to tell a moved pointer from a rewritten claim (`CTX-17.4`): when the
  // words the key used to cover are still there, only the pointer went somewhere else. Unless the new claim holds the
  // old one, which is a claim that grew, and reads as the change it is.
  let stripped = "";
  let last = 0;
  for (const p of [...pointers].sort((a, b) => a.at - b.at)) {
    stripped += after.slice(last, p.at) + " ";
    last = p.at + p.written.length;
  }
  stripped = normaliseClaim(stripped + after.slice(last));
  const keys = [...new Set(sources.map((s) => s.key))].sort();
  return keys.flatMap((key): ReferenceChange[] => {
    const summary = sources
      .filter((s) => s.key === key)
      .map((s) => `${s.source} ${s.recordedAt.slice(0, 10)}`)
      .join(", ");
    if (!now.has(key)) return was.has(key) ? [{ key, kind: "retired", sources: summary }] : [];
    const before = was.get(key);
    const after = now.get(key)!;
    if (before === undefined || before === after) return [];
    const moved = before !== "" && after !== "" && stripped.includes(before) && !after.includes(before);
    return [{ key, kind: "changed", sources: summary, before, after, ...(moved ? { moved: true as const } : {}) }];
  });
}
