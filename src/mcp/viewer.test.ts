/**
 * The viewer host's HTTP contract (VIEW-15). Two properties, both of which fail silently rather than loudly:
 * a blank page, and a graph showing work that no longer exists. Neither is visible from a passing build.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../db/testing";
import { one } from "../db/rows";
import { createProject, listProjects } from "../domain/projects";
import { createItem, deleteItem, listItems } from "../domain/items";
import { listAttachments } from "../domain/attachments";
import { getProjectByKey } from "../domain/projects";
import { createViewerHost, fileSources } from "./viewer";
import { createUnavailableMediaStore } from "../media/store";

const ACTOR = "test";

/**
 * A viewer "build" beside this module, at the `../roadmap/dist` candidate `createViewerHost` looks for. The
 * repo's real build usually sits there, so the test writes its own marker files into a temp dir and points
 * nothing at it - instead it asserts on whichever build is found, which is the honest thing to assert: the
 * headers are a property of the route, not of the file behind it.
 */
describe("the viewer host", () => {
  let base: string;
  let close: () => Promise<void>;
  let stop: () => Promise<void>;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "apm-viewer-"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "store.apm.yaml"), "projects: []\n");

    const fresh = await freshDb();
    close = fresh.close;
    const project = await createProject(fresh.db, { key: "apm", name: "AI PM", type: "software", ownerId: fresh.ownerId }, ACTOR);
    await createItem(fresh.db, { projectId: project.id, area: "MCP", title: "live" }, ACTOR);
    const doomed = await createItem(fresh.db, { projectId: project.id, area: "MCP", title: "doomed" }, ACTOR);
    await createItem(fresh.db, { projectId: project.id, area: "MCP", title: "depends on the doomed one", deps: [doomed.ref] }, ACTOR);
    await deleteItem(fresh.db, { projectId: project.id, ref: doomed.ref }, ACTOR);

    const host = createViewerHost(fresh.db, fileSources(join(dir, "store.apm.yaml")), { persist: async () => {}, refresh: async () => false, appendMeasurements: async () => {} }, { ownerId: fresh.ownerId });
    base = (await host.open("apm")).replace(/\/\?t=.*$/, "");
    stop = host.close;
  });

  afterAll(async () => {
    await stop();
    await close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves the plan without deleted tickets, or the graph draws finished work as live", async () => {
    const response = await fetch(`${base}/api/store`);
    const { store } = (await response.json()) as { store: { projects: { items: { ref: string; title: string; deps?: string[] }[] }[] } };
    const items = store.projects[0]!.items;
    expect(items.map((i) => i.title)).toEqual(["live", "depends on the doomed one"]);
    expect(items.flatMap((i) => i.deps ?? [])).toEqual([]);
  });

  it("never lets the live plan be cached", async () => {
    // Heuristic caching applies when a response says nothing, so silence here would mean a viewer that shows
    // a stale plan and gives no sign of it.
    const response = await fetch(`${base}/api/store`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("never lets the HTML entry point be cached, because a stale one 404s its own assets", async () => {
    // The trap this closes: assets are content-hashed, so a cached index.html outlives the hashes it names.
    // Rebuild the viewer with a tab open and that tab goes blank with nothing in the UI to explain it.
    const response = await fetch(`${base}/`);
    if (response.status === 503) return; // no viewer build in this checkout; the header cases below still hold
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("lets fingerprinted assets cache forever, which is safe for exactly the same reason", async () => {
    const index = await fetch(`${base}/`);
    if (index.status === 503) return;
    const asset = /src="([^"]+\.js)"/.exec(await index.text())?.[1];
    expect(asset).toBeDefined();
    const response = await fetch(`${base}${asset}`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});

describe("uploading an image (MEDIA-1, MEDIA-2, VIEW-17)", () => {
  // A real 1x1 PNG, so the whole path runs on bytes a browser would actually send.
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgMAAAABAAEAAAIBRAA7", "base64");
  let host: ReturnType<typeof createViewerHost>;
  let origin: string;
  let writeToken: string;
  let dir2: string;
  let db2: Awaited<ReturnType<typeof freshDb>>;

  beforeAll(async () => {
    dir2 = await mkdtemp(join(tmpdir(), "apm-upload-"));
    db2 = await freshDb();
    const project = await createProject(db2.db, { key: "plants", name: "Plants", type: "care", ownerId: db2.ownerId }, ACTOR);
    await createItem(db2.db, { projectId: project.id, area: "FIG", title: "fiddle leaf fig" }, ACTOR);
    const storePath = join(dir2, "plants.apm.yaml");
    host = createViewerHost(db2.db, fileSources(storePath), { persist: async () => {}, refresh: async () => false, appendMeasurements: async () => {} }, { ownerId: db2.ownerId });
    const url = await host.open("plants");
    origin = url.slice(0, url.indexOf("/?"));
    writeToken = /t=([a-f0-9]+)/.exec(url)![1]!;
  });

  afterAll(async () => {
    await host.close();
    await db2.close();
    await rm(dir2, { recursive: true, force: true });
  });

  /** A GET with an arbitrary Host header, which `fetch` refuses to send. */
  const statusWithHost = (path: string, host: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: Number(new URL(origin).port), path, headers: { host } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end();
    });

  const upload = (body: Buffer, headers: Record<string, string> = {}, qs = "?project=plants&ref=FIG-1") =>
    fetch(`${origin}/api/media${qs}`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-apm-token": writeToken, ...headers },
      body: body as unknown as BodyInit,
    });

  it("stores the bytes beside the plan and returns their content address", async () => {
    const response = await upload(PNG);
    expect(response.status).toBe(201);
    const { hash, url } = (await response.json()) as { hash: string; url: string };
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // Content-addressed, so the file on disk is named by what is in it - the property the cloud migration
    // later depends on.
    expect(existsSync(join(dir2, ".apm", "media", `${hash}.png`))).toBe(true);
    expect(url).toBe(`/media/${hash}`);
  });

  it("serves the blob back with the mime from the row, not from the request", async () => {
    const { hash } = (await (await upload(PNG)).json()) as { hash: string };
    const served = await fetch(`${origin}/media/${hash}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toContain("immutable"); // the name is the content
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("attaches it to the ticket, and a second drop of the same image is a no-op", async () => {
    await upload(PNG);
    await upload(PNG);
    const rows = await listAttachments(db2.db, (await getProjectByKey(db2.db, db2.ownerId, "plants"))!.id, "FIG-1");
    expect(rows).toHaveLength(1); // content-addressed: the same picture twice is one attachment
    expect(rows[0]!.mime).toBe("image/png");
  });

  it("refuses anything not addressed to 127.0.0.1, including reads", async () => {
    // DNS rebinding: a page on evil.com whose DNS re-resolves to loopback is same-origin with itself, so no
    // CORS applies and the response would be readable. Host is the one thing the attacker cannot forge, and
    // the read surface is the whole plan - so this guards reads, not just writes.
    // `fetch` will not send a forged Host - undici overwrites it - so this drops to a raw request, which is
    // also closer to what a rebound browser actually sends.
    expect(await statusWithHost("/api/store", "evil.example")).toBe(403);
    expect(await statusWithHost("/media/whatever", "evil.example")).toBe(403);
    // and the ordinary case still works
    expect((await fetch(`${origin}/api/store`)).status).toBe(200);
  });

  it("refuses a write with no token, a wrong token, or a foreign origin", async () => {
    // Any page open in the same browser can reach 127.0.0.1, so these are the whole defence (VIEW-17).
    expect((await upload(PNG, { "x-apm-token": "" })).status).toBe(403);
    expect((await upload(PNG, { "x-apm-token": "not-the-token" })).status).toBe(403);
    expect((await upload(PNG, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("refuses a type it could not display, and an empty file", async () => {
    expect((await upload(PNG, { "content-type": "image/heic" })).status).toBe(415);
    expect((await upload(Buffer.alloc(0))).status).toBe(415);
  });

  it("removes an attachment from the ticket, and leaves the blob on disk", async () => {
    const { hash } = (await (await upload(PNG)).json()) as { hash: string };
    const projectId = (await getProjectByKey(db2.db, db2.ownerId, "plants"))!.id;
    expect(await listAttachments(db2.db, projectId, "FIG-1")).toHaveLength(1);

    const removed = await fetch(`${origin}/api/media/${hash}?project=plants`, {
      method: "DELETE",
      headers: { "x-apm-token": writeToken },
    });
    expect(removed.status).toBe(200);
    expect(await listAttachments(db2.db, projectId, "FIG-1")).toHaveLength(0);
    // Another ticket may reference the same bytes, so removal takes it off the ticket rather than destroying
    // it. An orphaned blob costs disk; a wrongly deleted one costs a photograph.
    expect(existsSync(join(dir2, ".apm", "media", `${hash}.png`))).toBe(true);
  });

  it("guards removal exactly as it guards upload, since a DELETE is at least as destructive", async () => {
    const { hash } = (await (await upload(PNG)).json()) as { hash: string };
    const url = `${origin}/api/media/${hash}?project=plants`;
    expect((await fetch(url, { method: "DELETE" })).status).toBe(403); // no token
    expect((await fetch(url, { method: "DELETE", headers: { "x-apm-token": "nope" } })).status).toBe(403);
    expect((await fetch(url, { method: "DELETE", headers: { "x-apm-token": writeToken, origin: "https://evil.example" } })).status).toBe(403);
    // 405 rather than 404: the route exists, GET is simply not what it is for. Reading a blob is /media/<hash>.
    expect((await fetch(url, { method: "GET" })).status).toBe(405);
  });

  it("fails the call when the ticket does not exist, keeping the stored bytes as the cheaper failure", async () => {
    // The blob is already stored by this point and stays: put-then-row means a failed attach leaves an
    // invisible orphan (MEDIA-3), whereas row-then-put would leave a visible broken image. Fail towards
    // the one that costs disk rather than the one that looks like data loss.
    const response = await upload(PNG, {}, "?project=plants&ref=FIG-9");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('no ticket "FIG-9"');
  });
});

describe("the viewer host picks up an external change (IMP-10)", () => {
  let host: ReturnType<typeof createViewerHost>;
  let base: string;
  let db: Awaited<ReturnType<typeof freshDb>>;
  let dir: string;
  let refreshes = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "apm-viewer-reload-"));
    db = await freshDb();
    await createProject(db.db, { key: "apm", name: "AI PM", type: "software", ownerId: db.ownerId }, ACTOR);
    host = createViewerHost(db.db, fileSources(join(dir, "store.apm.yaml")), {
      persist: async () => {},
      appendMeasurements: async () => {},
      refresh: async () => {
        refreshes++;
        return false;
      },
    }, { ownerId: db.ownerId });
    base = (await host.open("apm")).replace(/\/\?t=.*$/, "");
  });

  afterAll(async () => {
    await host.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("re-reads the plan before serving it, so a graph refreshed after a git pull is the current one", async () => {
    // Without this the tab is the only thing that looks up to date: the user reloads, sees the same plan, and
    // has no way to tell that the process is serving the file as it was when it booted.
    const before = refreshes;
    await fetch(`${base}/api/store`);
    expect(refreshes).toBe(before + 1);
  });

  it("does not re-read for static assets, which are files rather than state", async () => {
    const before = refreshes;
    await fetch(`${base}/`);
    expect(refreshes).toBe(before);
  });
});

describe("changing a status from the graph (VIEW-17)", () => {
  let host: ReturnType<typeof createViewerHost>;
  let origin: string;
  let token: string;
  let db: Awaited<ReturnType<typeof freshDb>>;
  let dir: string;
  let persisted = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "apm-status-"));
    db = await freshDb();
    const project = await createProject(db.db, { key: "apm", name: "AI PM", type: "software", ownerId: db.ownerId }, ACTOR);
    await createItem(db.db, { projectId: project.id, area: "MCP", title: "the stdio server" }, ACTOR);
    host = createViewerHost(db.db, fileSources(join(dir, "plan.apm.yaml")), {
      persist: async () => {
        persisted++;
      },
      refresh: async () => false,
      appendMeasurements: async () => {},
    }, { ownerId: db.ownerId });
    const url = await host.open("apm");
    origin = url.slice(0, url.indexOf("/?"));
    token = /t=([a-f0-9]+)/.exec(url)![1]!;
  });

  afterAll(async () => {
    await host.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const change = (body: unknown, headers: Record<string, string> = {}, qs = "?project=apm&ref=MCP-1") =>
    fetch(`${origin}/api/ticket${qs}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-apm-token": token, ...headers },
      body: JSON.stringify(body),
    });

  it("moves the ticket and writes the store through, exactly as a tool call would", async () => {
    const before = persisted;
    const response = await change({ status: "in-progress" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ref: "MCP-1", status: "in-progress" });
    // The write-through is the durability: a browser edit that only reached memory would be lost on restart.
    expect(persisted).toBe(before + 1);
    expect(one(await listItems(db.db, { projectId: one(await listProjects(db.db, db.ownerId)).id })).status).toBe("in-progress");
  });

  it("refuses a status outside the vocabulary rather than storing one nothing renders", async () => {
    const response = await change({ status: "nearly" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("status must be one of");
  });

  it("names the field when it is missing, and does not leak JSON.parse's own message", async () => {
    // The body is validated by a zod schema like every other boundary in the project, so the reply names the
    // field rather than describing the shape of the payload. Malformed JSON used to come back as
    // "Unexpected token } in JSON at position 5" - an internal detail phrased for nobody.
    const missing = await change({});
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("status must be one of");

    const malformed = await fetch(`${origin}/api/ticket?project=apm&ref=MCP-1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-apm-token": token },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    const { error } = (await malformed.json()) as { error: string };
    expect(error).toBe("the request body is not valid JSON");
    expect(error).not.toContain("position");
  });

  it("answers an unknown ticket with the domain's own message", async () => {
    const response = await change({ status: "done" }, {}, "?project=apm&ref=MCP-9");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("MCP-9");
  });

  it("guards the write exactly as upload is guarded, since a status change is a write like any other", async () => {
    expect((await fetch(`${origin}/api/ticket?project=apm&ref=MCP-1`, { method: "GET" })).status).toBe(405);
    expect((await change({ status: "done" }, { "x-apm-token": "nope" })).status).toBe(403);
    expect((await change({ status: "done" }, { origin: "https://evil.example" })).status).toBe(403);
    // and none of that moved the ticket
    expect(one(await listItems(db.db, { projectId: one(await listProjects(db.db, db.ownerId)).id })).status).toBe("in-progress");
  });
});

describe("the write surface is guarded as a whole, not route by route (VIEW-17)", () => {
  let host: ReturnType<typeof createViewerHost>;
  let origin: string;
  let token: string;
  let db: Awaited<ReturnType<typeof freshDb>>;
  let dir: string;
  let persisted = 0;

  // Every path that writes, with the method it takes. Mirrors `WRITES` in viewer.ts deliberately: if a route
  // is added there and not here the counts below diverge, and if it is added to neither the guards silently
  // stop covering it - which is the failure this whole describe exists to make loud.
  const WRITES = [
    { path: "/api/ticket?project=apm&ref=MCP-1", method: "POST", body: JSON.stringify({ status: "done" }) },
    { path: "/api/media?project=apm&ref=MCP-1", method: "POST", body: "x" },
    { path: "/api/media/deadbeef?project=apm", method: "DELETE", body: undefined },
  ];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "apm-guards-"));
    db = await freshDb();
    const project = await createProject(db.db, { key: "apm", name: "AI PM", type: "software", ownerId: db.ownerId }, ACTOR);
    await createItem(db.db, { projectId: project.id, area: "MCP", title: "guarded" }, ACTOR);
    host = createViewerHost(db.db, fileSources(join(dir, "plan.apm.yaml")), {
      persist: async () => {
        persisted++;
      },
      refresh: async () => false,
      appendMeasurements: async () => {},
    }, { ownerId: db.ownerId });
    const url = await host.open("apm");
    origin = url.slice(0, url.indexOf("/?"));
    token = /t=([a-f0-9]+)/.exec(url)![1]!;
  });

  afterAll(async () => {
    await host.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses every write four ways, and none of them reaches the store", async () => {
    // Asserted over the whole surface rather than per route, because the danger is a *new* route that forgets
    // a guard - and a per-route test by construction only covers the routes someone remembered to test.
    const before = persisted;
    for (const write of WRITES) {
      const send = (headers: Record<string, string>, method = write.method) =>
        // No body on a GET: fetch refuses to build the request at all, which would fail the test for a
        // reason that has nothing to do with the server.
        fetch(`${origin}${write.path}`, { method, headers, body: method === "GET" ? undefined : write.body });

      // Wrong method: refused before the token is even considered, so a GET cannot probe a write route.
      expect((await send({ "x-apm-token": token }, "GET")).status, `${write.path} method`).toBe(405);
      expect((await send({})).status, `${write.path} no token`).toBe(403);
      expect((await send({ "x-apm-token": "wrong" })).status, `${write.path} bad token`).toBe(403);
      expect((await send({ "x-apm-token": token, origin: "https://evil.example" })).status, `${write.path} origin`).toBe(403);
    }
    // The real assertion: refused means refused, not "returned 403 and wrote anyway".
    expect(persisted).toBe(before);
  });

  /** A raw GET, because `fetch` normalises `../` out of a path before it reaches the wire - a traversal test
   *  written with `fetch` asks the server nothing and passes with the guard deleted (confirmed 2026-08-03). */
  const rawGet = (path: string): Promise<{ status: number; body: string }> =>
    new Promise((fulfil, fail) => {
      const call = httpRequest({ hostname: "127.0.0.1", port: Number(new URL(origin).port), path }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => fulfil({ status: response.statusCode ?? 0, body }));
      });
      call.on("error", fail);
      call.end();
    });

  it("serves nothing outside the viewer build, however the path is spelled", async () => {
    // Without the guard a static file server hands `/../../.ssh/id_rsa` to anything that can reach the port.
    // It shipped with the route and was not tested until 2026-08-03 - the guard you are surest of is the one
    // nobody checked.
    //
    // The target is one level above the build (`roadmap/vite.config.ts`, when root is `roadmap/dist`) rather
    // than `/etc/passwd`: it is a file that definitely exists just outside the boundary, so an escape reads as
    // a 200 with real content. Aiming further up only proved that three `../` do not reach `/etc`.
    for (const attempt of ["/../vite.config.ts", "/..%2fvite.config.ts", "/assets/../../vite.config.ts"]) {
      const { status, body } = await rawGet(attempt);
      expect([403, 404], `${attempt} was served (${status})`).toContain(status);
      expect(body, `${attempt} leaked file content`).not.toContain("defineConfig");
    }
  });
});

/**
 * Cloud mode has nowhere to put a blob (OPS-11). The property worth holding is that it says so rather than
 * accepting the bytes and losing them on the next deploy, which is the shape of bug that looks fine until the
 * file is wanted.
 */
describe("uploads when the store cannot hold them (OPS-11)", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgMAAAABAAEAAAIBRAA7", "base64");
  let db3: Awaited<ReturnType<typeof freshDb>>;
  let host3: ReturnType<typeof createViewerHost>;
  let origin3: string;
  let token3: string;

  beforeAll(async () => {
    db3 = await freshDb();
    await createProject(db3.db, { key: "cloud", name: "Cloud", type: "software", ownerId: db3.ownerId }, ACTOR);
    host3 = createViewerHost(
      db3.db,
      { media: createUnavailableMediaStore("uploads are not available in cloud mode yet"), storePath: null },
      { persist: async () => {}, refresh: async () => false, appendMeasurements: async () => {} },
      { ownerId: db3.ownerId },
    );
    const url = await host3.open("cloud");
    origin3 = url.slice(0, url.indexOf("/?"));
    token3 = /t=([a-f0-9]+)/.exec(url)![1]!;
  });

  afterAll(async () => {
    await host3.close();
    await db3.close();
  });

  it("refuses with 501 and the reason, rather than accepting bytes it cannot keep", async () => {
    const response = await fetch(`${origin3}/api/media?project=cloud`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-apm-token": token3 },
      body: PNG as unknown as BodyInit,
    });
    // 501, not a 4xx: nothing about the request is wrong, this deployment has nowhere to put it.
    expect(response.status).toBe(501);
    expect(((await response.json()) as { error: string }).error).toContain("not available in cloud mode");
  });

  it("still refuses an upload that a working store would have rejected on its merits", async () => {
    // The guard runs before the body is read, so it also short-circuits the size and mime checks. Asserted so
    // that a later change moving the guard below them shows up here rather than as a surprise 415.
    const response = await fetch(`${origin3}/api/media?project=cloud`, {
      method: "POST",
      headers: { "content-type": "application/zip", "x-apm-token": token3 },
      body: PNG as unknown as BodyInit,
    });
    expect(response.status).toBe(501);
  });

  it("tells the page uploads are off, so it can hide the control instead of offering a 501", async () => {
    const plan = (await (await fetch(`${origin3}/api/store`)).json()) as { path: string | null; uploadsDisabled: string | null };
    expect(plan.uploadsDisabled).toContain("not available in cloud mode");
    // Null, not a string: cloud mode has no plan file, and the viewer's toolbar has to survive that rather
    // than call .split() on it.
    expect(plan.path).toBeNull();
  });

  it("reads back nothing rather than throwing, so an older attachment row renders as a missing image", async () => {
    const store = createUnavailableMediaStore("nope");
    await expect(store.read("deadbeef", "image/png")).resolves.toBeNull();
    await expect(store.put(PNG, "image/png")).rejects.toThrow("nope");
  });
});
