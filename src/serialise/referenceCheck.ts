/**
 * `apm:check`'s rules for source references (`CTX-13`), over a parsed plan.
 *
 * Loading a plan never refuses over a reference - a hand edit that removed a pointer must still load - so this is
 * where those states are reported instead, and the build fails on them. Everything the commit-time trigger would
 * refuse is an error here too, because loading stood the trigger aside; and so is everything only a parse can see:
 * a malformed pointer, a key used twice, the blank line a pointer under a table needs.
 *
 * **A claim whose text has changed since its source is advisory, never an error.** That is the normal life of a
 * referenced claim - a body is edited, and the reference says so on the next read - not a broken file.
 */
import { normaliseClaim, parsePointers } from "../../scripts/references";
import type { Store } from "./plan";

type Sources = Record<string, { text: string; retired?: string }[]>;

export interface ReferenceReport {
  errors: string[];
  /** Live sources whose `text` no longer matches what their pointer covers. */
  changed: number;
}

export function checkReferences(store: Store): ReferenceReport {
  const errors: string[] = [];
  let changed = 0;

  for (const project of store.projects) {
    const owners: { label: string; text: string; sources: Sources }[] = [
      ...project.items.map((item) => ({ label: `${project.key} ${item.ref}`, text: item.body ?? "", sources: item.references ?? {} })),
      ...Object.entries(project.context ?? {}).map(([heading, content]) => ({
        label: `${project.key} context "${heading}"`,
        text: content,
        sources: project.context_references?.[heading] ?? {},
      })),
    ];
    for (const heading of Object.keys(project.context_references ?? {})) {
      if (!(heading in (project.context ?? {}))) errors.push(`${project.key}: references under context "${heading}", which has no section`);
    }

    const ownerOfKey = new Map<string, string>();
    for (const { label, text, sources } of owners) {
      const { pointers, problems } = parsePointers(text);
      for (const { problem } of problems) errors.push(`${label}: ${problem}`);

      const live = new Map(
        Object.entries(sources)
          .map(([key, rows]) => [key, rows.filter((row) => row.retired === undefined)] as const)
          .filter(([, rows]) => rows.length > 0),
      );
      const pointed = new Set(pointers.map((p) => p.key));

      for (const p of pointers) {
        const rows = live.get(p.key);
        if (rows === undefined) {
          errors.push(`${label}: [ref ${p.key}] has no ${p.key in sources ? "live " : ""}reference behind it`);
          continue;
        }
        changed += rows.filter((row) => normaliseClaim(row.text) !== p.covers).length;
      }
      for (const key of live.keys()) {
        if (!pointed.has(key)) errors.push(`${label}: reference ${key} is live but its pointer is not in the text (removed by hand, or only inside code, where it does not count)`);
        const elsewhere = ownerOfKey.get(key);
        if (elsewhere !== undefined && elsewhere !== label) errors.push(`${project.key}: reference ${key} is live in both ${elsewhere} and ${label}`);
        ownerOfKey.set(key, label);
      }
    }
  }
  return { errors, changed };
}
