import { describe, expect, it } from "vitest";
import { freshDb } from "../db/testing";
import { createProject } from "../domain/projects";
import { createItem, deleteItem } from "../domain/items";
import { addComment } from "../domain/comments";
import { addAttachment } from "../domain/attachments";
import { setSection } from "../domain/context";
import { asPlan, exportStore } from "../serialise/store";
import { itemFeed } from "./itemFeed";

const ACTOR = "test";

async function seeded() {
  const fixture = await freshDb();
  const project = await createProject(fixture.db, { key: "apm", name: "AI PM", type: "software", ownerId: fixture.ownerId }, ACTOR);
  await createItem(fixture.db, { projectId: project.id, area: "VIEW", title: "The pane", body: "Prose about the pane." }, ACTOR);
  await addComment(fixture.db, { projectId: project.id, itemId: (await createItem(fixture.db, { projectId: project.id, area: "VIEW", title: "Spare" }, ACTOR)).id, body: "on the other item" }, ACTOR);
  return { ...fixture, project };
}

describe("the bulk feed carries what the graph draws, not the pane (VIEW-29)", () => {
  it("drops bodies, comments and attachments, and keeps the rest", async () => {
    const { db, ownerId, project, close } = await seeded();
    await setSection(db, { projectId: project.id, heading: "Goal", content: "ship it" }, ACTOR);
    await addAttachment(db, { projectId: project.id, ref: "VIEW-1", hash: "a".repeat(64), mime: "image/png", bytes: 3 }, ACTOR);
    const [feed] = asPlan(await exportStore(db, ownerId)).projects;
    const item = feed!.items.find((candidate) => candidate.ref === "VIEW-1")!;
    expect(item.title).toBe("The pane");
    expect(item).not.toHaveProperty("body");
    expect(item).not.toHaveProperty("attachments");
    expect(feed!.items.some((candidate) => "comments" in candidate)).toBe(false);
    expect(feed!.context).toEqual({ Goal: "ship it" }); // the graph's context button still needs these
    await close();
  });
});

describe("itemFeed (VIEW-29)", () => {
  it("returns one item's body, comments newest first with agent ones tagged, and attachments", async () => {
    const { db, ownerId, project, close } = await seeded();
    const view1 = (await exportStore(db, ownerId)).projects[0]!.items.find((item) => item.ref === "VIEW-1")!;
    await addComment(db, { projectId: project.id, itemId: view1.id, body: "first" }, ACTOR);
    await addComment(db, { projectId: project.id, itemId: view1.id, body: "Claude's working note", audience: "agent" }, ACTOR);
    await addAttachment(db, { projectId: project.id, ref: "VIEW-1", hash: "b".repeat(64), mime: "image/png", bytes: 3, caption: "a sketch" }, ACTOR);

    const found = await itemFeed(db, ownerId, "apm", "VIEW-1");
    expect(found?.body).toBe("Prose about the pane.");
    expect(found?.comments.map((c) => [c.body, c.audience])).toEqual([
      ["Claude's working note", "agent"],
      ["first", "user"],
    ]);
    expect(found?.attachments).toMatchObject([{ hash: "b".repeat(64), caption: "a sketch" }]);
    await close();
  });

  it("answers null for an unknown project, an unknown ref, or a deleted item", async () => {
    const { db, ownerId, project, close } = await seeded();
    expect(await itemFeed(db, ownerId, "nope", "VIEW-1")).toBeNull();
    expect(await itemFeed(db, ownerId, "apm", "VIEW-99")).toBeNull();
    await deleteItem(db, { projectId: project.id, ref: "VIEW-1" }, ACTOR);
    expect(await itemFeed(db, ownerId, "apm", "VIEW-1")).toBeNull();
    await close();
  });
});
