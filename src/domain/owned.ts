/**
 * A project reference that has been checked against a caller (`DATA-16`).
 *
 * `OPS-4` made every query owner-scoped, but only by convention: the domain layer took `projectId: string`,
 * and nothing could tell an id that had been checked from one that had merely been read out of a row. Seven
 * call sites got it right because someone remembered seven times. This makes the eighth fail to compile.
 *
 * **How it works, and why the obvious version does not.** The brand is on what the *scoped resolvers return*,
 * never on the schema's column type. `projects.id` stays a plain `string`, so a row from any query - scoped or
 * not - carries an unbranded id that is not assignable to `OwnedProjectId`. Branding the column instead would
 * mark every row from every query and mean nothing, which is what made the first sketch of this ticket
 * conclude a brand was unworkable at all. It was the wrong brand, not the wrong idea.
 *
 * The payoff is that call sites do not change. Handlers already write `resolveProject(...)` then pass `p.id`
 * inward, and `p.id` is branded because `p` is - so this is a change to signatures and to three casts, not to
 * the code that uses them.
 *
 * **What it does not claim.** A determined `as OwnedProjectId` defeats it, and that is fine: the failure being
 * designed against is a forgotten check in code that looks reasonable, not someone deliberately routing round
 * a type. The cast that mints one lives in exactly one function in `projects.ts`, next to the ownership check
 * it stands for, so a reviewer has one place to look rather than seven.
 */
import type { projects } from "../db/schema";

declare const ownedBrand: unique symbol;

/** A project id resolved against an owner. Only `projects.ts` mints these. */
export type OwnedProjectId = string & { readonly [ownedBrand]: true };

/** A project row as it comes out of the database, with an id that carries no claim about who may see it. */
export type Project = typeof projects.$inferSelect;

/** The same row, having been resolved against a caller. */
export type OwnedProject = Omit<Project, "id"> & { readonly id: OwnedProjectId };
