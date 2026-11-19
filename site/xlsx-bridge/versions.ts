/**
 * Which spreadsheet in the folder is the plan (`DIST-9.1`). A locked-down Copilot, tried in the field (2026-11-19),
 * could not edit a file, only write a new one beside it, and named each `<plan>_v2.xlsx`, `<plan>_v3.xlsx` and on.
 * So the page follows a folder rather than a file, and shows the newest version of the plan: `plan.xlsx` is
 * version 1, `plan_v3.xlsx` version 3. Pure, so it is tested without a browser.
 */

export interface FolderEntry {
  name: string;
  modified: number;
}

export interface Version {
  file: string;
  /** The plan's name, the same for every version: what keys the project, so the viewer's URL survives a switch. */
  base: string;
  version: number;
  modified: number;
}

/** A spreadsheet's plan name and version, or null for anything else (Excel's `~$` lock files included). */
export function versionOf(entry: FolderEntry): Version | null {
  if (entry.name.startsWith("~$")) return null;
  const match = /^(.+?)(?:_v(\d+))?\.xlsx$/i.exec(entry.name);
  if (match === null) return null;
  return { file: entry.name, base: match[1]!, version: match[2] === undefined ? 1 : Number(match[2]), modified: entry.modified };
}

/**
 * The newest version of `base`, or, before one is chosen, of the plan whose file changed last. Two files claiming the
 * same version (`plan_v2.xlsx` and `Plan_V2.xlsx`) go to the one changed last.
 */
export function newest(entries: FolderEntry[], base?: string): Version | null {
  const versions = entries.map(versionOf).filter((v): v is Version => v !== null);
  const plan = base ?? [...versions].sort((a, b) => b.modified - a.modified)[0]?.base;
  const ofPlan = versions.filter((v) => v.base.toLowerCase() === plan?.toLowerCase());
  return ofPlan.sort((a, b) => b.version - a.version || b.modified - a.modified)[0] ?? null;
}
