/**
 * The plan workbook from the command line (`DIST-9.2`), ahead of the browser tab that will do this for real
 * (`DIST-9.1`): export a project to `plan.xlsx`, hand it to an assistant in Excel, and read its edits back.
 *
 *   yarn workspace attraverso workbook export --project apm --out ./kit [--store attraverso.yaml]
 *   yarn workspace attraverso workbook refresh --project apm --dir ./kit [--store attraverso.yaml] [--workbook edited.xlsx]
 *
 *   ... workbook refresh ... --apply
 *
 * `export` writes `plan.xlsx` and `plan.snapshot.json` (what a refresh diffs against) into the folder. `refresh`
 * reports what the workbook's edits would do to the plan as it is now - operations, fixes, flags, refusals and
 * conflicts - and applies nothing unless asked.
 *
 * **`--apply` writes through the server's own file writer** (`createStoreFile`), not the library's YAML callback:
 * the library hands back one whole plan, which would fold the references and layout back into the plan file,
 * where the server's writer keeps them in their side files and refuses to overwrite a change made since it read.
 * The operations still go through the library's project handle, so this is the same `applyOperations` the browser
 * tab (`DIST-9.1`) will call, and a viewer open on the file redraws as each one lands. It then re-exports the
 * workbook and snapshot, so the next round of edits starts from the plan as it now is.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStore } from "../../src/serialise/plan";
import { planRefresh, snapshotOf, type WorkbookSnapshot } from "./model";
import { readWorkbook, writeWorkbook } from "./xlsx";
import { applyOperations } from "./apply";
import { createStoreFile } from "../../src/serialise/store";
import { createInMemoryDb } from "../../src/db/memory";
import { ensureUser, LOCAL_IDENTITY } from "../../src/domain/users";
import { getProjectByKey } from "../../src/domain/projects";
import { projectHandle } from "../../src/library/project";

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = rest.indexOf(`--${name}`);
  return at === -1 ? undefined : rest[at + 1];
};
const need = (name: string): string => flag(name) ?? fail(`--${name} is required`);
function fail(message: string): never {
  console.error(`workbook: ${message}\nusage: workbook export --project <key> --out <dir> | workbook refresh --project <key> --dir <dir> [--workbook <xlsx>]`);
  process.exit(1);
}

const storePath = flag("store") ?? "attraverso.yaml";
const store = parseStore(readFileSync(storePath, "utf8"));
const project = need("project");

if (command === "export") {
  const out = need("out");
  const snapshot = snapshotOf(store, project);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "plan.xlsx"), await writeWorkbook(snapshot));
  writeFileSync(join(out, "plan.snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`wrote ${snapshot.items.length} items and ${snapshot.next.length} on Next to ${join(out, "plan.xlsx")}, with plan.snapshot.json beside it`);
} else if (command === "refresh") {
  const dir = need("dir");
  const base = JSON.parse(readFileSync(join(dir, "plan.snapshot.json"), "utf8")) as WorkbookSnapshot;
  if (base.project !== project) fail(`the snapshot is of ${base.project}, not ${project}`);
  const workbookPath = flag("workbook") ?? join(dir, "plan.xlsx");
  const grid = await readWorkbook(new Uint8Array(readFileSync(workbookPath)));
  const { operations, report } = planRefresh(base, grid, snapshotOf(store, project));
  console.log(`refresh of ${project} against the export of ${base.exportedAt}${rest.includes("--apply") ? "" : " (nothing applied; --apply to apply)"}`);
  const section = (title: string, lines: string[]) => lines.length > 0 && console.log(`\n${title} (${lines.length})\n${lines.map((l) => `  - ${l}`).join("\n")}`);
  section(
    "would apply",
    operations.map((o) => `${o.at}: ${JSON.stringify(o, (key, value) => (key === "at" ? undefined : key === "body" && typeof value === "string" ? `(${value.length} characters)` : value))}`),
  );
  for (const [kind, title] of [
    ["fixed", "fixed on the way"],
    ["flagged", "flagged for you"],
    ["conflict", "changed in the plan too, so kept the plan's"],
    ["refused", "refused"],
    ["note", "notes"],
  ] as const) {
    section(
      title,
      report.filter((l) => l.kind === kind).map((l) => `${l.at}: ${l.message}`),
    );
  }
  if (operations.length === 0 && report.length === 0) console.log("\nno changes");
  if (rest.includes("--apply") && operations.length > 0) {
    const file = createStoreFile(storePath);
    const { db, close } = await createInMemoryDb();
    try {
      await file.open(db);
      const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);
      const owned = (await getProjectByKey(db, ownerId, project)) ?? fail(`no project ${project} in ${storePath}`);
      const handle = projectHandle({
        db,
        project: owned,
        actor: "workbook",
        writing: async (work) => {
          const result = await work();
          await file.save(db);
          return result;
        },
      });
      const applied = await applyOperations(handle, operations);
      section(
        "applied",
        applied.map((a) => `${a.operation.at}: ${a.ok ? a.outcome : `REFUSED by the plan: ${a.outcome}`}`),
      );
      // Save the fixed version back (`DIST-9.2`'s step 5): the workbook and its snapshot re-exported from the plan
      // as it is now. Without it, the same workbook refreshed again would create every new row a second time, since
      // a new row carries no id and the old snapshot predates the item it made. What was refused is in the report
      // above, not lost silently.
      const now = snapshotOf(parseStore(readFileSync(storePath, "utf8")), project);
      writeFileSync(workbookPath, await writeWorkbook(now));
      writeFileSync(join(dir, "plan.snapshot.json"), JSON.stringify(now, null, 2) + "\n");
      console.log(`\nwritten to ${storePath}, and ${workbookPath} re-exported from it, so the next edits start from here`);
    } finally {
      await close();
    }
  }
} else fail(`unknown command "${command ?? ""}"`);
