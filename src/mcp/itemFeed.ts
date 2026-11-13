/**
 * What `GET /api/item` answers (`VIEW-29`): everything the detail pane draws for one item, fetched when it is
 * opened rather than shipped for every item on every page load.
 *
 * **The rule this ticket settled**: the bulk feed (`/api/store`, through `asPlan`) carries what the *graph* draws
 * - refs, titles, statuses, deps, layout, context - and the pane's prose comes from here, one item at a time,
 * since one item is all a pane can show. Before it, bodies and comments were 89% of an 806 kB feed, and the
 * comments were never rendered at all.
 *
 * One function for every host, as `storeFeed` and `searchFeed` are, so the loopback viewer, the hosted server and
 * the dev server cannot answer one path with three shapes.
 */
import type { Database } from "../db/client";
import { listAttachments } from "../domain/attachments";
import { listComments } from "../domain/comments";
import { getItem } from "../domain/items";
import { getProjectByKey } from "../domain/projects";

/** Comments on one item, all of them: the pane shows the whole record, and a busy item has a few dozen. */
const COMMENT_LIMIT = 500;

export interface ItemFeed {
  ref: string;
  body: string;
  /** Newest first, as `list_comments` returns them. Agent comments are included and tagged: unsurfaced by
   *  default in the pane, never withheld (`CLAUDE.md`, `audience`). */
  comments: { id: string; body: string; audience: "user" | "agent"; actor: string; at: string }[];
  /** Oldest first, so a sequence of photos reads in the order it was taken. */
  attachments: { hash: string; mime: string; bytes: number; caption?: string; at: string }[];
}

/** Null when the owner has no such project, or the project no such live item; a host answers 404. */
export async function itemFeed(db: Database, ownerId: string, projectKey: string, ref: string): Promise<ItemFeed | null> {
  const project = await getProjectByKey(db, ownerId, projectKey);
  if (project === null) return null;
  const item = await getItem(db, project.id, ref);
  if (item === null || item.deletedAt !== null) return null;
  const [comments, attachments] = await Promise.all([
    listComments(db, { projectId: project.id, itemId: item.id, limit: COMMENT_LIMIT }),
    listAttachments(db, project.id, ref),
  ]);
  return {
    ref: item.ref,
    body: item.body ?? "",
    comments: comments.map((c) => ({ id: c.id, body: c.body, audience: c.audience as "user" | "agent", actor: c.actor, at: c.createdAt })),
    attachments: attachments.map((a) => ({ hash: a.hash, mime: a.mime, bytes: a.bytes, ...(a.caption ? { caption: a.caption } : {}), at: a.createdAt })),
  };
}
