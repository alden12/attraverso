import { describe, expect, it } from "vitest";
import { freshDb } from "../db/testing";
import { createProject } from "../domain/projects";
import { createItem, setStatus } from "../domain/items";
import { setLayout } from "../domain/layout";
import { versionFeed } from "./versionFeed";

const ACTOR = "test";

describe("versionFeed (VIEW-7)", () => {
  it("moves when the plan changes, and not when only the layout is saved", async () => {
    const { db, ownerId, close } = await freshDb();
    const project = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);
    const first = (await versionFeed(db, ownerId, 0)).version;

    await createItem(db, { projectId: project.id, area: "VIEW", title: "Live refresh" }, ACTOR);
    const afterItem = (await versionFeed(db, ownerId, 0)).version;
    expect(afterItem).not.toBe(first);

    await setStatus(db, { projectId: project.id, ref: "VIEW-1", status: "in-progress" }, ACTOR);
    const afterStatus = (await versionFeed(db, ownerId, 0)).version;
    expect(afterStatus).not.toBe(afterItem);

    // The viewer's own memory of where things sit: saved after every draw, so it must not set every tab refetching.
    await setLayout(db, project.id, { "VIEW-1": { x: 10, y: 20 } }, ACTOR);
    expect((await versionFeed(db, ownerId, 0)).version).toBe(afterStatus);
    await close();
  });

  it("counts reloads from disk, which clear the event log and could otherwise read the same twice", async () => {
    const { db, ownerId, close } = await freshDb();
    expect((await versionFeed(db, ownerId, 1)).version).not.toBe((await versionFeed(db, ownerId, 2)).version);
    await close();
  });
});
