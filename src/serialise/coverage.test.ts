/**
 * Export coverage guard (IMP-8). The YAML store (store.ts) is a hand-written, deliberately *transformed*
 * projection of the tables - refs instead of uuids, deps folded onto items, context as a heading -> content
 * map - so it can never be code-generated from the schema. What it must not do is silently drift: a column
 * added in a later migration that nobody serialises would just vanish from every export.
 *
 * This test closes that gap. Every column of every table must be classified below as either `exported`
 * (carried into a file) or `omitted` (deliberately not, with the reason). Which file is the plan unless the
 * entry says otherwise - see `file` on `Coverage`. Add a column and this fails until
 * you make that decision - so serialisation stays a conscious choice, not an accident. The manifest also
 * doubles as the record of what is intentionally left out. (That the `exported` columns actually survive a
 * round trip is what store.test.ts proves; this test guarantees none are forgotten in the first place.)
 */
import { describe, expect, it } from "vitest";
import { getTableColumns, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";
import { allowedEmails, areas, attachments, contextSections, dependencies, events, items, comments, measurements, projectNext, projects, scopedDependencies, users } from "../db/schema";

interface Coverage {
  table: PgTable;
  exported: string[];
  omitted: string[];
  /**
   * Which file carries the exported columns, when it is not the plan file (`METRIC-1`).
   *
   * The guard originally assumed one destination, because there was one. `measurements` breaks that: they are
   * append-heavy and a year of them outweighs the plan they hang off, so `IMP-7`'s split-by-volatility rule
   * routes them elsewhere. That is a *different destination*, not an exemption - every column still has to be
   * classified here, and naming the file is what stops "exported" quietly meaning "exported somewhere".
   */
  file?: string;
}

const COVERAGE: Record<string, Coverage> = {
  allowedEmails: {
    table: allowedEmails,
    // Like `users`, and for the same reason: who may reach a *deployment* is not part of a plan, and a
    // committed store carrying an invite list would hand it to anyone who cloned the repo (OPS-4).
    exported: [],
    omitted: ["email", "note", "createdAt"],
  },
  users: {
    table: users,
    // Nothing at all: identity belongs to a deployment, not to a plan. A committed store recording its owner
    // would have a clone import the committer's account (OPS-4).
    exported: [],
    omitted: ["id", "issuer", "subject", "email", "createdAt"],
  },
  scopedDependencies: {
    table: scopedDependencies,
    // Folded onto the dependent item's `deps:` beside the local ones, as `apm:DIST-1` (`PROJ-11`). A scoped
    // edge is a dependency that happens to name a project, not a second kind of thing, so it shares the key.
    exported: ["targetProject", "targetRef"],
    // `itemId` is implied by which item carries the list; `createdAt` matches `dependencies`, which omits it
    // for the same reason - it is not information anyone reads out of a plan file.
    omitted: ["itemId", "createdAt"],
  },
  projects: {
    table: projects,
    exported: ["id", "key", "name", "type", "direction", "status", "createdAt", "updatedAt", "archivedAt"],
    omitted: ["ownerId"], // see `users`: assigned by the runtime from the caller, never carried in the file
  },
  areas: {
    table: areas,
    exported: ["id", "key", "name", "description", "colour", "sortOrder", "createdAt"],
    omitted: ["projectId"], // implied by nesting under the project
  },
  items: {
    table: items,
    exported: ["id", "ref", "areaKey", "sortPath", "parentId", "title", "body", "status", "createdAt", "updatedAt", "closedAt", "deletedAt"],
    // projectId is implied by nesting under the project; `tsv` is never exported: a generated column, derived from columns that *are* exported and
    // rebuilt by Postgres on import (DATA-11).
    omitted: ["projectId", "tsv"],
  },
  dependencies: {
    table: dependencies,
    exported: ["itemId", "dependsOnId"], // folded onto the dependent item as `deps: [ref, ...]`
    omitted: ["createdAt"], // regenerated on import; not user-facing, and not part of the round trip
  },
  projectNext: {
    table: projectNext,
    // Folded onto the project as `next: [ref, ...]`. `position` is not exported because the array's order is
    // the position: writing both would be two sources for one fact, and renumbering on load makes a
    // hand-reordered file simply correct rather than inconsistent.
    exported: ["itemId"],
    omitted: ["projectId", "position"],
  },
  measurements: {
    table: measurements,
    // Everything but the ids implied by nesting. `parentId` IS carried, unlike `items.parentId`, because a
    // measurement has no ref to derive nesting from - the tree is only in this column.
    exported: ["id", "itemId", "parentId", "metric", "value", "textValue", "unit", "label", "at", "source", "actor", "createdAt"],
    omitted: ["projectId"], // implied by which project's measurement file it is in
    file: ".apm/measurements/YYYY-MM.yaml (written by METRIC-2)",
  },
  contextSections: {
    table: contextSections,
    exported: ["heading", "content"], // a readable heading -> content map
    // Identity is the heading; order is map order; the rest regenerated. `tsv` is never exported: a generated column, derived from columns that *are* exported and
    // rebuilt by Postgres on import (DATA-11).
    omitted: ["id", "projectId", "sortOrder", "createdAt", "updatedAt", "tsv"],
  },
  attachments: {
    table: attachments,
    // The hash is the whole reference; the bytes live under .apm/media/ and are deliberately not in the YAML.
    exported: ["id", "hash", "mime", "bytes", "caption", "actor", "createdAt"],
    omitted: ["projectId", "itemId"], // both implied by nesting: under the project, or under its item
  },
  comments: {
    table: comments,
    // Carries its `id`: comments are editable and deletable, so they need a stable address.
    exported: ["id", "body", "audience", "actor", "createdAt"],
    // projectId and itemId are implied by nesting: under the project, or under its item. `tsv` is never exported: a generated column, derived from columns that *are* exported and
    // rebuilt by Postgres on import (DATA-11).
    omitted: ["projectId", "itemId", "tsv"],
  },
  events: {
    table: events,
    exported: [], // the audit log is never exported - for committed state, git is the trail (IMP-7)
    omitted: ["id", "projectId", "entityType", "entityId", "at", "actor", "kind", "correlationId", "before", "after"],
  },
};

describe("YAML export coverage (IMP-8)", () => {
  /**
   * The per-column checks below only run for tables someone listed, so until this existed a whole *table*
   * could be added and covered by nothing - as `notes` in fact was. Adding `users` in `OPS-4` would have
   * slipped through the same gap, which is what surfaced it. Derived from the module's exports rather than a
   * second hand-written list, so there is no third place to keep in step.
   */
  it("accounts for every table in the schema", () => {
    const tables = Object.entries(schema)
      .filter(([, value]) => is(value, PgTable))
      .map(([name]) => name)
      .sort();
    expect(Object.keys(COVERAGE).sort()).toEqual(tables);
  });

  for (const [name, coverage] of Object.entries(COVERAGE)) {
    it(`accounts for every column of ${name}`, () => {
      const actual = Object.keys(getTableColumns(coverage.table)).sort();
      const accounted = [...coverage.exported, ...coverage.omitted].sort();
      // Exact match both ways: a new unclassified column, a removed column, or a duplicate all fail here.
      expect(accounted).toEqual(actual);
    });
  }
});
