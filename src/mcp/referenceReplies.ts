/**
 * How a writing tool reports what it did to source references (`CTX-13`). Reply formatting, so it lives with the
 * tools rather than in `domain/`, which returns the facts: the sources added, the sourced claims an edit changed or
 * retired, and anything about the pointers a writer should hear now rather than from `apm:check` later.
 */
import { parsePointers } from "../../scripts/references";
import type { AddedSource, ReferenceChange } from "../domain/references";

/** The sourced claims an edit touched, as lines. Empty when nothing sourced was touched, so a reply stays as it was. */
export function fmtReferenceChanges(changes: ReferenceChange[]): string {
  if (changes.length === 0) return "";
  const lines = changes.map((c) =>
    c.kind === "retired"
      ? `- ${c.key} (${c.sources}): pointer removed, so its sources were retired`
      : c.moved === true
        ? `- ${c.key} (${c.sources}): the pointer now sits on a different claim, "${c.after}" (it was on "${c.before}", which is unchanged). Kept; reads "text changed since" until a source is added for the claim it now covers`
        : `- ${c.key} (${c.sources}): "${c.before}" -> "${c.after}". Kept; reads "text changed since" until a source is added for the new text`,
  );
  return `\nsourced claims you changed:\n${lines.join("\n")}`;
}

/**
 * What a write did to sources, from what was actually written: the keys given new sources, the ones re-checked, the
 * sources reused from other claims (`CTX-17.5`), the keys cleared (`CTX-17.2`), and the problems with the text's
 * pointers.
 */
export function fmtSourcesWritten(added: AddedSource[], text: string | null, cleared: string[] = []): string {
  const fresh = [...new Set(added.filter((a) => !a.replaced).map((a) => a.key))];
  const rechecked = [...new Set(added.filter((a) => a.replaced).map((a) => a.key))];
  const reused = added.filter((a) => a.alsoBehind !== undefined).map((a) => `${a.key} (${a.source}, also behind ${a.alsoBehind} other claim${a.alsoBehind === 1 ? "" : "s"})`);
  const problems = text === null ? [] : parsePointers(text).problems.map((p) => p.problem);
  return (
    (fresh.length > 0 ? `\nsources added to: ${fresh.join(", ")}` : "") +
    (rechecked.length > 0 ? `\nsources re-checked (the claim's current text and today's date replace the old): ${rechecked.join(", ")}` : "") +
    (reused.length > 0 ? `\nreused sources: ${reused.join(", ")}` : "") +
    (cleared.length > 0 ? `\nsources cleared from: ${cleared.join(", ")} (each pointer now reads "no reference behind it" until a source is added or it is removed)` : "") +
    (problems.length > 0 ? `\npointer problems (the text is saved; fix these with another edit):\n${problems.map((p) => `- ${p}`).join("\n")}` : "")
  );
}
