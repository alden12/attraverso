/**
 * That an unscoped project reference does not compile (`DATA-16`).
 *
 * These are **type** assertions, checked by `yarn typecheck` rather than at runtime - `@ts-expect-error` fails
 * the build if the line it marks stops being an error, which is exactly the regression to catch. The bodies
 * never run, and must not: they would reach a database, and what is being tested is whether the code would
 * have been allowed to exist at all.
 *
 * The runtime half of the guarantee - that a project belonging to one owner is unreachable from another - is
 * in `users.test.ts` and stays there. This file only asserts that the compiler makes the mistake impossible to
 * write in the first place.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema";
import type { Database } from "../db/client";
import { getItem } from "./items";
import { listSections } from "./context";
import { getProjectByKey, listProjects, setDirection } from "./projects";
import type { OwnedProjectId } from "./owned";

/** Never called. Every line here is an assertion about what the compiler accepts. */
async function typeAssertions(db: Database, ownerId: string): Promise<void> {
  // The mistake this ticket exists to prevent: look a project up yourself, skip the ownership check, and hand
  // the id to the domain layer. It reads perfectly reasonably, which is why a reviewer would let it past.
  const rows = await db.select().from(projects).where(eq(projects.key, "apm"));
  // @ts-expect-error an id read straight from a row has not been checked against any caller
  await getItem(db, rows[0]!.id, "MCP-1");
  // @ts-expect-error the same, through a different door
  await listSections(db, rows[0]!.id);
  // @ts-expect-error and a literal, which is how it would look in a hand-written script
  await setDirection(db, "some-project-id", "north star", "test");

  // The scoped resolvers mint the reference, so these are the paths that do compile.
  const checked = await getProjectByKey(db, ownerId, "apm");
  if (checked !== null) await getItem(db, checked.id, "MCP-1");
  for (const project of await listProjects(db, ownerId)) await listSections(db, project.id);

  // And the brand is not a separate value to carry around: it is still a string at runtime, so anything that
  // only reads the id keeps working untouched.
  const id: string = checked === null ? "" : checked.id;
  void id;
}

describe("an unscoped project reference (DATA-16)", () => {
  it("is rejected by the compiler, which is the whole test", () => {
    // `yarn typecheck` is the assertion; this exists so the file is visibly part of the suite rather than
    // looking like dead code someone could delete.
    expect(typeof typeAssertions).toBe("function");
  });

  it("is still a plain string at runtime, so nothing pays for the guarantee", () => {
    const id = "01a0-not-really-a-uuid" as OwnedProjectId;
    expect(typeof id).toBe("string");
    expect(id.startsWith("01a0")).toBe(true);
  });
});
