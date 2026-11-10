/**
 * Rows to public records (`DIST-6`). Explicit field by field, so a column added to the schema stays out of the API
 * until someone decides it belongs in it.
 */
import type { OwnedProject } from "../domain/projects";
import type { Item as ItemRow, ItemSummary as ItemSummaryRow } from "../domain/items";
import type { Comment as CommentRow } from "../domain/comments";
import type { Comment, Item, ItemSummary, ProjectInfo } from "./index";

export const projectOf = (p: OwnedProject): ProjectInfo => ({ key: p.key, name: p.name, type: p.type, direction: p.direction ?? null });

/** `A-3.1` -> `A-3`; an undotted ref has no parent. */
const parentOf = (ref: string): string | null => (ref.includes(".") ? ref.slice(0, ref.lastIndexOf(".")) : null);

export const summaryOf = (i: ItemSummaryRow): ItemSummary => ({
  ref: i.ref,
  area: i.areaKey,
  parent: parentOf(i.ref),
  title: i.title,
  status: i.status,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
  closedAt: i.closedAt,
  start: i.startOn,
  due: i.dueOn,
});

export const itemOf = (i: ItemRow): Item => ({ ...summaryOf(i), body: i.body ?? "" });

export const commentOf = (c: CommentRow, ref: string | null): Comment => ({ id: c.id, ref, body: c.body, audience: c.audience, actor: c.actor, at: c.createdAt });
