/**
 * Not-found errors that answer the question instead of pointing at another tool (MCP-14).
 *
 * `project` is required on every tool, and a ref or heading is required wherever one applies. That is only
 * cheap if getting one wrong costs a single call: an error saying "call list_projects to see them" makes the
 * model pay a round-trip to learn something the failing call already knew. So a failed lookup names what it
 * could have matched.
 *
 * The bound matters as much as the naming. Listing every value is right for projects and context sections,
 * which are few; it is wrong for tickets, where a real project has hundreds and dumping them all would trade
 * one round-trip for a far larger cost. Hence the two modes: everything when the list is short, near misses
 * plus a pointer at the listing tool when it is not.
 */

/** Above this many candidates, only near misses are offered. Chosen to comfortably cover a project's context
 *  sections and a person's projects, and to exclude any real ticket backlog. */
const LIST_ALL_UP_TO = 12;

/** How many near misses are worth offering. More than a handful stops being a suggestion and starts being a
 *  listing, which is the thing the bound exists to avoid. */
const NEAR_MISSES = 5;

/**
 * The tail of a not-found message: every candidate when there are few enough to be worth the context,
 * otherwise the near misses and where to find the rest. Empty when there are no candidates at all - the
 * caller says what that means, because "no projects yet" and "no tickets yet" are different situations.
 */
export function suggest(needle: string, candidates: string[], listTool: string, listAllUpTo = LIST_ALL_UP_TO): string {
  if (candidates.length === 0) return "";
  if (candidates.length <= listAllUpTo) return ` Available: ${candidates.join(", ")}.`;
  const near = nearMisses(needle, candidates);
  if (near.length === 0) return ` ${candidates.length} exist - call ${listTool} to see them.`;
  return ` Did you mean: ${near.join(", ")}? (${candidates.length} in total - call ${listTool} to see them all.)`;
}

/** Candidates close enough to `needle` to be worth offering, closest first. */
export function nearMisses(needle: string, candidates: string[], limit = NEAR_MISSES): string[] {
  const wanted = needle.trim().toLowerCase();
  if (wanted === "") return [];
  return candidates
    .map((candidate) => ({ candidate, gap: gapTo(wanted, candidate.toLowerCase()) }))
    .filter((scored): scored is { candidate: string; gap: number } => scored.gap !== null)
    // Array.prototype.sort is stable, so equal gaps keep the caller's order - which is the store's own
    // ordering (area then sort_path), not an accident of iteration.
    .sort((a, b) => a.gap - b.gap)
    .slice(0, limit)
    .map((scored) => scored.candidate);
}

/**
 * How far a candidate is from what was asked for; null means "not close enough to offer at all".
 *
 * Containment scores 0 rather than being measured as a typo, because a partial handle is the commonest near
 * miss and is not a misspelling: "MCP" for `MCP-3`, "storage" for "The storage model". The distance threshold
 * scales with length so that a short ref tolerates one slip and a long heading tolerates a few, rather than a
 * fixed budget that is generous for `MCP-3` and stingy for "Working agreements".
 */
function gapTo(needle: string, candidate: string): number | null {
  if (candidate.includes(needle) || needle.includes(candidate)) return 0;
  const gap = distance(needle, candidate);
  return gap <= Math.max(1, Math.floor(Math.min(needle.length, candidate.length) / 3)) ? gap : null;
}

/** Levenshtein distance, two rows at a time. The inputs are handles (a ref, a key, a heading) compared against
 *  at most a few hundred candidates on a failure path only, so the quadratic cost is irrelevant here. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length]!;
}
