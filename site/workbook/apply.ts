/**
 * Apply a refresh's operations to a plan (`DIST-9.2`), through the library (`DIST-6`): the same door the browser tab
 * (`DIST-9.1`) will use, so each write is exactly a tool call's write, with its event row and its save.
 *
 * **One at a time, and a failure stops only its own row.** The model has already refused what it can see is wrong,
 * but the domain is the guarantee - a dependency cycle, say, is found only by writing - so each operation's outcome
 * is reported against the row it came from, and the rest still go in.
 *
 * Order: edits and statuses first, then new items, then the Next list, which may name what was just edited.
 */
import type { PlanProject } from "../../src/library";
import type { WorkbookOperation } from "./model";

export interface Applied {
  operation: WorkbookOperation;
  /** What it did ("created VIEW-3", "VIEW-2 done"), or why the plan refused it. */
  outcome: string;
  ok: boolean;
}

const ORDER: Record<WorkbookOperation["kind"], number> = { edit: 0, status: 1, create: 2, next: 3 };

export async function applyOperations(project: PlanProject, operations: WorkbookOperation[]): Promise<Applied[]> {
  const applied: Applied[] = [];
  for (const operation of [...operations].sort((a, b) => ORDER[a.kind] - ORDER[b.kind])) {
    try {
      applied.push({ operation, ok: true, outcome: await apply(project, operation) });
    } catch (error) {
      applied.push({ operation, ok: false, outcome: error instanceof Error ? error.message : String(error) });
    }
  }
  return applied;
}

async function apply(project: PlanProject, op: WorkbookOperation): Promise<string> {
  switch (op.kind) {
    case "edit":
      await project.editItem(op.ref, op.changes);
      return `edited ${op.ref} (${Object.keys(op.changes).join(", ")})`;
    case "status":
      await project.setStatus(op.ref, op.status);
      return `${op.ref} is ${op.status}`;
    case "create": {
      const item = await project.createItem({
        ...op.under,
        title: op.title,
        status: op.status,
        ...(op.deps.length > 0 ? { deps: op.deps } : {}),
        ...(op.body !== "" ? { body: op.body } : {}),
        ...(op.start !== undefined ? { start: op.start } : {}),
        ...(op.due !== undefined ? { due: op.due } : {}),
      });
      return `created ${item.ref} "${item.title}"`;
    }
    case "next":
      return `Next is ${(await project.setNext(op.refs)).join(", ") || "empty"}`;
  }
}
