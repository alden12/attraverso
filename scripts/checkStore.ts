/**
 * Validate the project store (the `apm:check` in `yarn verify`, replacing the old `roadmap:check` now that
 * the store, not `ROADMAP.md`, is the source of truth). It resolves the store the same way the server does
 * (the nearest `attraverso.yaml` or legacy `*.apm.yaml`, or `--store <path>`), parses it against the store schema, and loads it into a
 * throwaway in-memory database via `importStore` - the boot path - so a schema violation, a duplicate ref, or
 * a dependency/parent pointing at no item fails here, in CI, rather than at read time. A CLI, so stdout is fine.
 *
 * **Every store, not the first one** (`IMP-17`). A plan can span several files, and the server holds their
 * union, so a check that read one of them would validate a graph the server never loads - and once `DIST-3`
 * splits this plan in two, the half it skipped is the half nobody is checking. Loading them all into one
 * database also catches what only the union can show: two files claiming the same project.
 *
 * **And every file must already be in the layout a save would write** (`IMP-19`). A file edited by hand keeps
 * its own layout until the next save rewrites it, so that save's diff buries its one real change under
 * everything the hand edit left behind - 1,740 lines around two in one project's first cloud round trip. Sync
 * cannot tell those apart, so it is refused here, where a person is looking. `--fix` rewrites each file
 * through the save path itself; commit that on its own, so the reformatting is one reviewable step rather than
 * noise inside the next real change.
 */
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { createInMemoryDb } from "../src/db/memory";
import { checkReferences } from "../src/serialise/referenceCheck";
import {
  assertDistinctProjects,
  canonicalForms,
  importStore,
  orphanedReferences,
  parseReferences,
  parseStore,
  resolveStorePaths,
  storePathsIn,
  withSides,
  writeAtomic,
} from "../src/serialise/store";
import { referencesPathFor } from "../src/serialise/paths";

async function main(): Promise<void> {
  const paths = resolveStorePaths(storePathsIn(process.argv));
  const missing = paths.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    console.error(`store: FAILED\n${missing.map((path) => `  - ${path} does not exist`).join("\n")}`);
    process.exit(1);
  }
  // Parsed before anything is loaded, so a schema error names its own file rather than surfacing as a
  // failure to insert whichever file happened to be read first.
  // With their side files laid over them, layout and source references, as the server loads them.
  const stores = await Promise.all(
    paths.map(async (path) => {
      const text = readFileSync(path, "utf8");
      return { path, text, store: await withSides(path, parseStore(text)) };
    }),
  );
  // Named before the insert that would otherwise report it as a unique-index violation on two uuids.
  assertDistinctProjects(stores);
  const fix = process.argv.includes("--fix");
  const drifted: string[] = [];
  const { db, close } = await createInMemoryDb();
  try {
    // FK-validates every dependency and parent, and rejects two files that hold the same project.
    for (const { store } of stores) await importStore(db, store);

    const canonical = await canonicalForms(db, stores);
    // The plan files and their references files (real data, so held to the same standard): every one a save
    // would write, and every one on disk, so a references file the plan no longer needs is caught too.
    const onDisk = new Map(stores.map(({ path, text }) => [path, text]));
    for (const { path } of stores) {
      const references = referencesPathFor(path);
      if (existsSync(references)) onDisk.set(references, readFileSync(references, "utf8"));
      else if (canonical.has(references)) onDisk.set(references, "");
    }
    for (const [path, text] of onDisk) {
      const expected = canonical.get(path) ?? (path.endsWith("references.yaml") ? "{}\n" : undefined);
      if (expected === undefined || expected === text) continue;
      if (fix) {
        await writeAtomic(path, expected);
        console.log(`store: rewrote ${shown(path)} in the layout a save writes`);
      } else {
        drifted.push(`${shown(path)}: differs from what a save would write, from line ${firstDifference(text, expected)}`);
      }
    }
  } finally {
    await close();
  }
  if (drifted.length > 0) {
    console.error(
      `store: NOT CANONICAL\n${drifted.map((line) => `  - ${line}`).join("\n")}\n` +
        "  Edited outside the tools, so the next save would rewrite it and bury its real change in the diff.\n" +
        "  Run `yarn apm:check --fix` and commit the result on its own.",
    );
    process.exit(1);
  }
  // Source references (CTX-13): what loading let through, and what only a parse of the prose can see.
  const references = stores.map(({ path, store }) => ({ path, ...checkReferences(store) }));
  const referenceErrors = references.flatMap(({ path, errors }) => errors.map((error) => `${shown(path)}: ${error}`));
  // And sources in a references file with nowhere to go: a project, item or heading no plan has, which a save drops.
  for (const path of new Set(paths.map(referencesPathFor))) {
    if (!existsSync(path)) continue;
    for (const orphan of orphanedReferences(stores.map(({ store }) => store), parseReferences(readFileSync(path, "utf8")))) {
      referenceErrors.push(`${shown(path)}: ${orphan}`);
    }
  }
  if (referenceErrors.length > 0) {
    console.error(`store: REFERENCES\n${referenceErrors.map((line) => `  - ${line}`).join("\n")}`);
    process.exit(1);
  }
  const changed = references.reduce((sum, { changed }) => sum + changed, 0);
  if (changed > 0) console.log(`store: ${changed} source${changed === 1 ? "" : "s"} vouched for text that has changed since (advisory)`);
  const totals = stores
    .flatMap(({ store }) => store.projects)
    .map((p) => `${p.key}: ${p.items.length} items, ${p.areas.length} areas`)
    .join("; ");
  console.log(`store: OK (${totals}) in ${paths.length === 1 ? paths[0] : `${paths.length} files`}.`);
}

/** A path relative to where the command ran when it is inside it, absolute otherwise - `../../..` is not a
 *  location anyone can act on. */
function shown(path: string): string {
  const near = relative(process.cwd(), path);
  return near === "" || near.startsWith("..") ? path : near;
}

/** The 1-based line where two texts first disagree, so the report points somewhere a person can look. */
function firstDifference(a: string, b: string): number {
  const left = a.split("\n");
  const right = b.split("\n");
  const at = left.findIndex((line, index) => line !== right[index]);
  return (at === -1 ? Math.min(left.length, right.length) : at) + 1;
}

main().catch((error) => {
  console.error(`store: FAILED\n  - ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
