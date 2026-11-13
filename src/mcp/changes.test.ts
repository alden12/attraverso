import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChangeFeed, type ChangeFeed } from "./changes";

/** Just enough of a response to hold a stream open and read back what was written to it. */
function fakeResponse() {
  const emitter = new EventEmitter();
  const written: string[] = [];
  const response = Object.assign(emitter, {
    writeHead: () => response,
    write: (chunk: string) => written.push(chunk) > 0,
    end: () => emitter.emit("close"),
  }) as unknown as ServerResponse;
  const tokens = () => written.filter((chunk) => chunk.startsWith("event: version")).map((chunk) => chunk.split("data: ")[1]!.trim());
  return { response, tokens, hangUp: () => emitter.emit("close") };
}

const until = async (check: () => boolean) => {
  for (let tries = 0; tries < 100 && !check(); tries++) await new Promise((wait) => setTimeout(wait, 20));
  expect(check()).toBe(true);
};

describe("the change feed (VIEW-7)", () => {
  let feed: ChangeFeed | null = null;
  let dir = "";
  afterEach(async () => {
    feed?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("sends the token on connect, then once per settled burst of writes, renames included", async () => {
    dir = await mkdtemp(join(tmpdir(), "apm-changes-"));
    const plan = join(dir, "attraverso.yaml");
    await writeFile(plan, "one");
    let version = 1;
    let reads = 0;
    feed = createChangeFeed([plan], async () => (reads++, `v${version}`), 30);
    const page = fakeResponse();
    await feed.subscribe(page.response);
    expect(page.tokens()).toEqual(["v1"]);

    // A burst: three writes, the last one an atomic rename over the file, as git and the write-through both do.
    version = 2;
    await writeFile(plan, "two");
    await writeFile(plan, "three");
    await writeFile(join(dir, "attraverso.yaml.tmp"), "four");
    await rename(join(dir, "attraverso.yaml.tmp"), plan);
    await until(() => page.tokens().length === 2);
    expect(page.tokens()).toEqual(["v1", "v2"]);

    // And it still hears the file after the rename replaced it.
    version = 3;
    await writeFile(plan, "five");
    await until(() => page.tokens().length === 3);
    expect(reads).toBeLessThan(6);
  });

  it("says nothing when the token did not move, or about other files in the folder", async () => {
    dir = await mkdtemp(join(tmpdir(), "apm-changes-"));
    const plan = join(dir, "attraverso.yaml");
    await writeFile(plan, "one");
    let reads = 0;
    feed = createChangeFeed([plan], async () => (reads++, "same"), 30);
    const page = fakeResponse();
    await feed.subscribe(page.response);
    // macOS can deliver the file's creation above late, after the watch starts, so count from a settled point.
    await new Promise((wait) => setTimeout(wait, 150));
    const settled = reads;
    await writeFile(join(dir, "notes.txt"), "unrelated");
    await new Promise((wait) => setTimeout(wait, 150));
    expect(reads).toBe(settled);
    await writeFile(plan, "touched, same token");
    await until(() => reads === settled + 1);
    expect(page.tokens()).toEqual(["same"]);
  });

  it("stops watching when the last page goes", async () => {
    dir = await mkdtemp(join(tmpdir(), "apm-changes-"));
    const plan = join(dir, "attraverso.yaml");
    await writeFile(plan, "one");
    let reads = 0;
    feed = createChangeFeed([plan], async () => (reads++, `v${reads}`), 30);
    const page = fakeResponse();
    await feed.subscribe(page.response);
    expect(feed.listeners()).toBe(1);
    await new Promise((wait) => setTimeout(wait, 150));
    page.hangUp();
    expect(feed.listeners()).toBe(0);
    const settled = reads;
    await writeFile(plan, "nobody listening");
    await new Promise((wait) => setTimeout(wait, 150));
    expect(reads).toBe(settled);
  });
});
