import { describe, expect, it } from "vitest";
import { freshDb } from "../db/testing";
import { createProject } from "../domain/projects";
import { createItem, deleteItem } from "../domain/items";
import { searchFeed } from "./searchFeed";

const ACTOR = "test";

async function seeded() {
  const fixture = await freshDb();
  const project = await createProject(fixture.db, { key: "apm", name: "AI PM", type: "software", ownerId: fixture.ownerId }, ACTOR);
  await createItem(fixture.db, { projectId: project.id, area: "VIEW", title: "Collapse an area", body: "See VIEW-2 for the search box." }, ACTOR);
  await createItem(fixture.db, { projectId: project.id, area: "VIEW", title: "Find a ticket" }, ACTOR);
  return { ...fixture, project };
}

describe("searchFeed (VIEW-25)", () => {
  it("puts the item a ref names first, however it was typed, and once", async () => {
    const { db, ownerId, close } = await seeded();
    const found = await searchFeed(db, ownerId, "apm", "view-2");
    expect(found?.hits[0]).toMatchObject({ source: "item", ref: "VIEW-2", title: "Find a ticket" });
    expect(found?.hits.filter((hit) => hit.source === "item" && hit.ref === "VIEW-2")).toHaveLength(1);
    await close();
  });

  it("does not name a deleted item, and searches as typed otherwise", async () => {
    const { db, ownerId, project, close } = await seeded();
    await deleteItem(db, { projectId: project.id, ref: "VIEW-2" }, ACTOR);
    expect((await searchFeed(db, ownerId, "apm", "VIEW-2"))?.hits.map((hit) => hit.ref)).not.toContain("VIEW-2");
    expect((await searchFeed(db, ownerId, "apm", "collap"))?.hits.map((hit) => hit.ref)).toEqual(["VIEW-1"]);
    await close();
  });

  it("answers null for a project the caller does not have, which a host turns into a 404", async () => {
    const { db, ownerId, close } = await seeded();
    expect(await searchFeed(db, ownerId, "nope", "anything")).toBeNull();
    await close();
  });

  it("brackets the matches, so a body's own bold is not mistaken for one", async () => {
    const { db, ownerId, project, close } = await seeded();
    await createItem(db, { projectId: project.id, area: "DATA", title: "Edges", body: "Before it, a **bold claim** and then many edges into one box." }, ACTOR);
    const snippet = (await searchFeed(db, ownerId, "apm", "many edges"))?.hits.find((hit) => hit.ref === "DATA-1")?.snippet ?? "";
    expect(snippet).toContain("⟦many⟧");
    expect(snippet).toContain("**bold claim**"); // the body's own markup, left for the viewer to drop
    expect(snippet).not.toContain("**many**");
    await close();
  });
});
