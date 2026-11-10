/**
 * One project's handle (`DIST-6`): each call is the domain function a tool would call, scoped to the project, and
 * each write goes through `writing` so it resolves only once its save has.
 */
import type { Database } from "../db/client";
import type { OwnedProject } from "../domain/projects";
import { createItem, editItem, getItem, getItemDetail, listItems, setStatus } from "../domain/items";
import { addComment, listComments } from "../domain/comments";
import { getSection, setSection } from "../domain/context";
import { search, DEFAULT_LIMIT } from "../domain/search";
import type { PlanProject } from "./index";
import { commentOf, itemOf, summaryOf } from "./records";

export interface HandleContext {
  db: Database;
  project: OwnedProject;
  /** Who the event log and new comments name. */
  actor: string;
  /** Run a mutation, then its save. */
  writing: <T>(work: () => Promise<T>) => Promise<T>;
}

export function projectHandle({ db, project, actor, writing }: HandleContext): PlanProject {
  const projectId = project.id;
  const itemIdOf = async (ref: string): Promise<string> => {
    const found = await getItem(db, projectId, ref);
    if (found === null) throw new Error(`no item "${ref}" in ${project.key}`);
    return found.id;
  };

  return {
    key: project.key,
    listItems: async (filter = {}) => (await listItems(db, { projectId, ...filter })).map(summaryOf),
    getItem: async (ref) => {
      const detail = await getItemDetail(db, projectId, ref);
      if (detail === null) return null;
      return { ...itemOf(detail.item), deps: detail.deps, comments: detail.comments.map((c) => commentOf(c, detail.item.ref)) };
    },
    createItem: (input) => writing(async () => itemOf(await createItem(db, { projectId, ...input }, actor))),
    editItem: (ref, changes) => writing(async () => itemOf(await editItem(db, { projectId, ref, ...changes }, actor))),
    setStatus: (ref, status) => writing(async () => itemOf(await setStatus(db, { projectId, ref, status }, actor))),
    addComment: (ref, body, { audience } = {}) =>
      writing(async () => {
        const itemId = await itemIdOf(ref);
        return commentOf(await addComment(db, { projectId, body, itemId, audience }, actor), ref);
      }),
    listComments: async ({ ref, audience, limit } = {}) => {
      const itemId = ref === undefined || ref === null ? ref : await itemIdOf(ref);
      const rows = await listComments(db, { projectId, itemId, audience, limit });
      const refById = new Map((await listItems(db, { projectId })).map((i) => [i.id, i.ref]));
      return rows.map((c) => commentOf(c, c.itemId === null ? null : (refById.get(c.itemId) ?? null)));
    },
    getSection: async (heading) => (await getSection(db, projectId, heading))?.content ?? null,
    setSection: (heading, content, { after } = {}) =>
      writing(async () => {
        await setSection(db, { projectId, heading, content, after }, actor);
      }),
    search: async (query, { limit = DEFAULT_LIMIT } = {}) => {
      const { hits, relaxed } = await search(db, projectId, query, limit);
      return { hits: hits.map((hit) => ({ ...hit })), relaxed };
    },
  };
}
