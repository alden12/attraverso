/**
 * Opening a plan (`DIST-6`): the in-memory database, the YAML loaded into it, and the write-through to `save`. The
 * public face of this is `openPlan` in `index.ts`, whose types are the contract this fulfils.
 */
import { createInMemoryDb } from "../db/memory";
import { exportStore, importStore, parseStore, stringifyStore } from "../serialise/plan";
import { ensureUser, LOCAL_IDENTITY } from "../domain/users";
import { createProjectWithDefaults, getProjectByKey, listProjects, type OwnedProject } from "../domain/projects";
import type { Plan, PlanOptions } from "./index";
import { projectHandle } from "./project";
import { projectOf } from "./records";

export async function open(options: PlanOptions): Promise<Plan> {
  const actor = options.actor ?? "claude";
  const { db, close } = await createInMemoryDb();
  try {
    // A blank document parses to null, which is a new plan rather than a malformed one.
    if (options.yaml !== undefined && options.yaml.trim() !== "") await importStore(db, parseStore(options.yaml));
  } catch (error) {
    await close();
    throw error;
  }
  // The single local account, as the stdio server acts as: `importStore` stamps it on everything it loads.
  const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);

  const toYaml = async (): Promise<string> => stringifyStore(await exportStore(db, ownerId));

  // Saves are chained so they land in the order of the writes even when a caller does not await between them.
  // A failed save rejects its own write and does not poison the next one.
  let saving: Promise<unknown> = Promise.resolve();
  const persist = async (): Promise<void> => {
    const save = options.save;
    if (save === undefined) return;
    const next = saving.then(async () => save(await toYaml()));
    saving = next.catch(() => {});
    await next;
  };
  /** A mutation, then its save, so a write resolves only once it is durable wherever `save` puts it. */
  const writing = async <T>(work: () => Promise<T>): Promise<T> => {
    const result = await work();
    await persist();
    return result;
  };

  const resolve = async (key: string): Promise<OwnedProject> => {
    const project = await getProjectByKey(db, ownerId, key);
    if (project === null) throw new Error(`no project with key "${key}"`);
    return project;
  };

  return {
    listProjects: async () => (await listProjects(db, ownerId)).map(projectOf),
    createProject: (input) => writing(async () => projectOf(await createProjectWithDefaults(db, { ...input, ownerId }, actor))),
    project: async (key) => projectHandle({ db, project: await resolve(key), actor, writing }),
    toYaml,
    close: async () => {
      await saving;
      await close();
    },
  };
}
