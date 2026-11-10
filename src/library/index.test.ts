/**
 * The in-process library (`DIST-6`) against its own promises: typed records rather than text, a write-through to
 * `save` after every change, and a plan that reopens from what was saved exactly as it was. The packed-package
 * smoke test (`scripts/packageSmoke.ts`) runs the same calls against the built tarball in Node and a browser;
 * this is the fast version over the source.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPlan, type Plan } from "./index";
import { createStoreFile } from "../serialise/store";
import { createInMemoryDb } from "../db/memory";

const open: Plan[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((plan) => plan.close()));
});
const opened = async (...args: Parameters<typeof openPlan>): Promise<Plan> => {
  const plan = await openPlan(...args);
  open.push(plan);
  return plan;
};

describe("openPlan (DIST-6)", () => {
  it("creates, reads and edits through typed calls, with no text to parse", async () => {
    const plan = await opened();
    expect(await plan.listProjects()).toEqual([]);
    expect(await plan.createProject({ key: "world", name: "A world", type: "world", direction: "Somewhere" })).toEqual({
      key: "world",
      name: "A world",
      type: "world",
      direction: "Somewhere",
    });
    const world = await plan.project("world");

    const created = await world.createItem({ area: "NPC", title: "The ferryman", body: "Takes coins." });
    expect(created).toMatchObject({ ref: "NPC-1", area: "NPC", parent: null, title: "The ferryman", status: "to-do", body: "Takes coins." });
    const child = await world.createItem({ parent: "NPC-1", title: "His boat" });
    expect(child).toMatchObject({ ref: "NPC-1.1", parent: "NPC-1", body: "" });

    await world.editItem("NPC-1", { body: "Takes two coins." });
    await world.setStatus("NPC-1", "done");
    await world.addComment("NPC-1", "Met at the river.");
    await world.addComment("NPC-1.1", "Leaks.");

    const detail = await world.getItem("NPC-1");
    expect(detail).toMatchObject({ ref: "NPC-1", status: "done", body: "Takes two coins.", deps: [] });
    expect(detail?.comments.map((c) => [c.ref, c.body])).toEqual([["NPC-1", "Met at the river."]]);
    expect(await world.getItem("NPC-9")).toBeNull();

    expect((await world.listItems()).map((i) => i.ref)).toEqual(["NPC-1", "NPC-1.1"]);
    expect((await world.listItems({ status: "done" })).map((i) => i.ref)).toEqual(["NPC-1"]);
    expect((await world.listComments({ ref: "NPC-1.1" })).map((c) => c.body)).toEqual(["Leaks."]);
    expect((await world.listComments()).map((c) => c.ref)).toEqual(["NPC-1.1", "NPC-1"]);

    await world.setSection("Story so far", "It began at the river.");
    expect(await world.getSection("Story so far")).toBe("It began at the river.");
    expect(await world.getSection("Nothing")).toBeNull();

    const { hits } = await world.search("ferryman");
    expect(hits[0]).toMatchObject({ source: "item", ref: "NPC-1", title: "The ferryman" });
  });

  it("names what is missing, rather than failing somewhere downstream", async () => {
    const plan = await opened();
    await expect(plan.project("nope")).rejects.toThrow('no project with key "nope"');
    await plan.createProject({ key: "p", name: "P", type: "world" });
    const p = await plan.project("p");
    await expect(p.addComment("X-1", "hello")).rejects.toThrow('no item "X-1" in p');
  });

  it("saves the whole plan after every write, and reopens from it exactly", async () => {
    const saves: string[] = [];
    const plan = await opened({ save: (yaml) => void saves.push(yaml) });
    await plan.createProject({ key: "p", name: "P", type: "world" });
    const p = await plan.project("p");
    await p.createItem({ area: "A", title: "One" });
    await p.listItems(); // a read saves nothing
    await p.addComment("A-1", "noted");
    expect(saves).toHaveLength(3);
    expect(saves.at(-1)).toBe(await plan.toYaml());

    const again = await opened({ yaml: saves.at(-1) });
    expect(await again.toYaml()).toBe(saves.at(-1));
    expect((await (await again.project("p")).getItem("A-1"))?.comments.map((c) => c.body)).toEqual(["noted"]);
  });

  it("keeps saves in write order when the writes are not awaited one by one", async () => {
    const saves: string[] = [];
    // A slow first save: without the chain, the second write's save would land first.
    let first = true;
    const plan = await opened({
      save: async (yaml) => {
        if (first) {
          first = false;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        saves.push(yaml);
      },
    });
    await Promise.all([plan.createProject({ key: "a", name: "A", type: "world" }), plan.createProject({ key: "b", name: "B", type: "world" })]);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toContain("key: b");
  });

  it("fails the write whose save failed, and carries on after it", async () => {
    let fail = true;
    const plan = await opened({
      save: () => {
        if (fail) throw new Error("disk full");
      },
    });
    await expect(plan.createProject({ key: "a", name: "A", type: "world" })).rejects.toThrow("disk full");
    fail = false;
    await expect(plan.createProject({ key: "b", name: "B", type: "world" })).resolves.toMatchObject({ key: "b" });
  });

  it("writes the same YAML the file-backed server does", async () => {
    // The browser and the stdio server must produce interchangeable plans: a playthrough saved in one has to open
    // in the other. So the same writes through each, compared byte for byte.
    const dir = await mkdtemp(join(tmpdir(), "attraverso-library-"));
    try {
      const plan = await opened();
      await plan.createProject({ key: "p", name: "P", type: "world" });
      await (await plan.project("p")).createItem({ area: "A", title: "One", body: "Body" });
      const yaml = await plan.toYaml();

      // Load that text into the server's own StoreFile and save it back out: the server's serialisation of it.
      const path = join(dir, "attraverso.yaml");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, yaml);
      const { db, close } = await createInMemoryDb();
      try {
        const store = createStoreFile(path);
        await store.open(db);
        await store.save(db);
        expect(await readFile(path, "utf8")).toBe(yaml);
      } finally {
        await close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
