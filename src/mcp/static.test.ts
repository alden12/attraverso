/**
 * The static file server behind the consent page and the viewer (`VIEW-24`).
 *
 * The traversal guard is the reason this is tested at all: this process can read anything the machine can, so
 * a request that escapes the build directory reads private keys rather than returning a 404.
 *
 * Tested directly rather than over HTTP, deliberately. `fetch` normalises `../` out of a path before it
 * reaches the wire, so a traversal test written with a client asks the server nothing and passes with the
 * guard deleted - which `VIEW-20` records as having actually happened to the loopback host's version.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheFor, serveFile } from "./static";

let root = "";
let outside = "";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "apm-static-"));
  root = join(dir, "build");
  outside = join(dir, "secret.txt");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><title>viewer</title>");
  await writeFile(join(root, "assets", "app-abc123.js"), "console.log(1)");
  // Real files just outside the root, so a successful escape returns content rather than a miss - otherwise
  // these tests pass with the guard deleted, on the strength of the file not existing.
  await writeFile(outside, "the private key");
  await mkdir(join(dir, "build-old"), { recursive: true });
  await writeFile(join(dir, "build-old", "index.html"), "the previous build");
});

afterAll(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

describe("serveFile", () => {
  it("serves a file from the build, with its type", async () => {
    const file = await serveFile(root, "index.html");
    expect(file?.body.toString()).toContain("viewer");
    expect(file?.type).toBe("text/html; charset=utf-8");
  });

  it("refuses to walk out of the build directory", async () => {
    // The whole point. Each of these resolves to a real, readable file if the guard is not there.
    expect(await serveFile(root, "../secret.txt")).toBeNull();
    expect(await serveFile(root, "assets/../../secret.txt")).toBeNull();
    expect(await serveFile(root, "./assets/../.././secret.txt")).toBeNull();
  });

  it("refuses a sibling directory that merely starts with the same name", async () => {
    // `startsWith(dir)` without the separator would let `/app/build-old` pass as inside `/app/build`.
    expect(await serveFile(root, "../build-old/index.html")).toBeNull();
  });

  it("returns null for a file that is simply absent, rather than throwing", async () => {
    expect(await serveFile(root, "nope.js")).toBeNull();
  });
});

describe("cacheFor", () => {
  it("never caches html, and caches fingerprinted assets forever", async () => {
    // An index.html allowed to go stale names asset hashes that no longer exist, and the page renders blank.
    expect(cacheFor("/build/index.html")).toBe("no-store");
    expect(cacheFor("/build/assets/app-abc123.js")).toBe("public, max-age=31536000, immutable");
  });
});
