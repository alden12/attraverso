/**
 * Optional viewer extensions: tried by name, absent when not installed, and served under their prefix through the
 * node adapter. A made-up extension module stands in for a real package, so core's tests never depend on one.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { extensionFor, loadExtensions, serveExtension } from "./extensions";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((done) => done()));

/** A module exporting `viewerExtension` that echoes what it is given, under `/echo`. */
const fixture = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "viewer-extension-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "echo.mjs");
  writeFileSync(
    file,
    `export const viewerExtension = ({ plans }) => ({
      prefix: "/echo",
      label: "Echo",
      async handle(request) {
        const url = new URL(request.url);
        if (url.pathname === "/echo/skip") return undefined;
        const body = request.method === "POST" ? await request.text() : "";
        return new Response(JSON.stringify({ path: url.pathname, plans, body }), { headers: { "x-from": "echo" } });
      },
    });`,
  );
  return pathToFileURL(file).href;
};

describe("loadExtensions", () => {
  it("is empty when a package isn't installed, and makes one that is for the host's plans", async () => {
    expect(await loadExtensions(["/plan/attraverso.yaml"], ["@example/not-installed/host"])).toEqual([]);
    const [echo] = await loadExtensions(["/plan/attraverso.yaml"], [fixture()]);
    expect(echo?.prefix).toBe("/echo");
    expect(echo?.label).toBe("Echo");
  });

  it("leaves out one that is installed but exports no extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-extension-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "empty.mjs"), "export const nothing = 1;");
    expect(await loadExtensions([], [pathToFileURL(join(dir, "empty.mjs")).href])).toEqual([]);
  });
});

describe("serving an extension", () => {
  it("matches its prefix only, and answers through the node adapter with its body and headers", async () => {
    const extensions = await loadExtensions(["/plan/attraverso.yaml"], [fixture()]);
    expect(extensionFor(extensions, "/echo")).toBeDefined();
    expect(extensionFor(extensions, "/echo/api/reviews")).toBeDefined();
    expect(extensionFor(extensions, "/echoes")).toBeUndefined();
    expect(extensionFor(extensions, "/api/store")).toBeUndefined();

    const server: Server = createServer((request, response) => {
      void serveExtension(extensions[0]!, request, response, "http://127.0.0.1").then((answered) => {
        if (!answered) response.end("passed on");
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanup.push(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const posted = await fetch(`${base}/echo/api/reading`, { method: "POST", body: "hello" });
    expect(posted.headers.get("x-from")).toBe("echo");
    expect(posted.headers.get("cache-control")).toBe("no-store");
    expect(await posted.json()).toEqual({ path: "/echo/api/reading", plans: ["/plan/attraverso.yaml"], body: "hello" });
    expect(await (await fetch(`${base}/echo/skip`)).text()).toBe("passed on");
  });
});
