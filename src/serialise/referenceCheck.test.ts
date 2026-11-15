import { describe, expect, it } from "vitest";
import { freshDb } from "../db/testing";
import { sourceReferences } from "../db/schema";
import { createProject } from "../domain/projects";
import { createItem } from "../domain/items";
import { exportStore, type Store } from "./plan";
import { checkReferences } from "./referenceCheck";

/** A plan with one item holding one referenced claim, as the exporter writes it, for each case to bend. */
async function plan(): Promise<Store> {
  const { db, ownerId, close } = await freshDb();
  const project = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, "test");
  const item = await createItem(db, { projectId: project.id, area: "OPS", title: "hosting", body: "The database runs Postgres 18.4 [ref r7k2]." }, "test");
  await db.insert(sourceReferences).values({
    projectId: project.id,
    key: "r7k2",
    itemId: item.id,
    source: "search",
    detail: "https://example.com/docs",
    quotedText: "The database runs Postgres 18.4",
    actor: "test",
  });
  const store = await exportStore(db, ownerId);
  await close();
  return store;
}

const item = (store: Store) => store.projects[0]!.items[0]!;

describe("apm:check's reference rules (CTX-13)", () => {
  it("passes a referenced claim whose text still matches its source", async () => {
    expect(checkReferences(await plan())).toEqual({ errors: [], changed: 0 });
  });

  it("counts a claim edited since its source as advisory, never an error", async () => {
    const store = await plan();
    item(store).body = "The database runs Postgres 18.6 [ref r7k2].";
    expect(checkReferences(store)).toEqual({ errors: [], changed: 1 });
  });

  it("reports a live reference whose pointer was removed by hand, which loading let through", async () => {
    const store = await plan();
    item(store).body = "The database runs Postgres 18.4.";
    expect(checkReferences(store).errors).toEqual(["apm OPS-1: reference r7k2 is live but its pointer is not in the text"]);
  });

  it("reports a pointer with nothing behind it, and one whose reference was retired", async () => {
    const store = await plan();
    item(store).body = "The database runs Postgres 18.4 [ref r7k2]. A VM [ref f1x9].";
    expect(checkReferences(store).errors).toEqual(["apm OPS-1: [ref f1x9] has no reference behind it"]);
    item(store).references!.r7k2![0]!.retired = "2026-11-15T00:00:00.000Z";
    expect(checkReferences(store).errors).toContain("apm OPS-1: [ref r7k2] has no live reference behind it");
  });

  it("reports one key live under two items", async () => {
    const store = await plan();
    const other = { ...structuredClone(item(store)), ref: "OPS-2", id: "other" };
    store.projects[0]!.items.push(other);
    expect(checkReferences(store).errors).toEqual(["apm: reference r7k2 is live in both apm OPS-1 and apm OPS-2"]);
  });

  it("reports references under a context heading the plan does not have", async () => {
    const store = await plan();
    store.projects[0]!.context_references = { Missing: { a1: [] } };
    expect(checkReferences(store).errors).toEqual(['apm: references under context "Missing", which has no section']);
  });

  it("reports a parse problem, such as a malformed pointer, under the owner's name", async () => {
    const store = await plan();
    item(store).body = "The database runs Postgres 18.4 [ref r7k2]. Broken [ref R2].";
    expect(checkReferences(store).errors).toHaveLength(1);
    expect(checkReferences(store).errors[0]).toMatch(/^apm OPS-1: .*is not a pointer/);
  });
});
