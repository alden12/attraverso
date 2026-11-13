import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { existsSync } from "node:fs";
import { asPlan, displayPath, mergeLayout, parseLayout, resolveStorePaths, type Store } from "../src/serialise/store";
import { layoutPathFor } from "../src/serialise/paths";
import type { Database } from "../src/db/client";
import { summariseFromFiles } from "../src/serialise/measurements";
import { createChangeFeed } from "../src/mcp/changes";

// The viewer's Vite root is this folder, set explicitly rather than left to the invocation: `vite --config
// roadmap/vite.config.ts` would otherwise leave the root at the repo root and never find index.html. It reads
// scripts/tickets.ts from the repo root by relative path, so widen the fs allow-list to the repo root. This is
// a dev-only tool, so it keeps its own config apart from the server's build config at the repo root.
const viewerRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Serves the plan at `/api/store` (VIEW-11), so the viewer fetches its data at runtime instead of having
 * `roadmap.apm.yaml` inlined into the bundle at build time.
 *
 * The path is resolved exactly as the MCP server resolves it (`APM_STORE_PATH`, else the nearest
 * `*.apm.yaml` walking up from the working directory), so `yarn viewer` and Claude Desktop never disagree
 * about which file is "the" store, and `APM_STORE_PATH=~/.ai-project-manager/project.apm.yaml yarn viewer`
 * renders a personal project with nothing to configure.
 *
 * **Several stores serve as their union** (`IMP-17`), which is what the server holds, so a split plan renders
 * as one graph here too. Any of them changing refreshes the page, because the viewer's job is to show what the
 * plan currently is and it cannot know which file a reader is watching.
 *
 * An edit to the YAML - by the MCP server writing through, or by hand - is pushed down `/api/changes` to an open
 * page, which refetches the plan in place (VIEW-7), keeping its selection, filters and layout.
 */
function servePlan(): Plugin {
  const storePaths = resolveStorePaths();
  let search: ReturnType<typeof buildSearch> | null = null;
  let dev: ViteDevServer | null = null;
  const searchable = () => (search ??= buildSearch(dev!));
  const forgetSearch = () => {
    const stale = search;
    search = null;
    void stale?.then(({ close }) => close()).catch(() => {});
  };
  // Loaded through Vite rather than imported at the top: the in-memory database bundles its migrations with
  // `import.meta.glob`, which only exists in code Vite has transformed, and this config file is not.
  const load = <T,>(server: ViteDevServer, path: string) => server.ssrLoadModule(fileURLToPath(new URL(path, import.meta.url))) as Promise<T>;
  async function buildSearch(server: ViteDevServer) {
    const { createInMemoryDb } = await load<typeof import("../src/db/memory")>(server, "../src/db/memory.ts");
    const { importStore } = await load<typeof import("../src/serialise/store")>(server, "../src/serialise/store.ts");
    const { ensureUser, LOCAL_IDENTITY } = await load<typeof import("../src/domain/users")>(server, "../src/domain/users.ts");
    const { searchFeed } = await load<typeof import("../src/mcp/searchFeed")>(server, "../src/mcp/searchFeed.ts");
    const { itemFeed } = await load<typeof import("../src/mcp/itemFeed")>(server, "../src/mcp/itemFeed.ts");
    const { db, close } = await createInMemoryDb();
    const stores = await Promise.all(storePaths.map(async (path) => parse(await readFile(path, "utf8")) as Store));
    await importStore(db, { projects: stores.flatMap((store) => store.projects ?? []) });
    const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);
    return { db: db as Database, ownerId, close, searchFeed, itemFeed };
  }
  const described = storePaths.join(", ");
  return {
    name: "apm-serve-store",
    configureServer(server: ViteDevServer) {
      dev = server;
      for (const path of storePaths) server.watcher.add(path);
      // A changed plan file reaches an open page through `/api/changes` below (VIEW-7), rather than
      // a full page reload over Vite's socket: that threw away the selection, the open pane and the filters, which
      // is exactly what a live refresh has to keep.
      server.watcher.on("change", (file) => {
        if (storePaths.includes(file)) forgetSearch(); // rebuilt from the changed files on the next search
      });
      // Live refresh (VIEW-7), through the same change feed the MCP server's host uses. The token is the files'
      // modification times: this server never writes, so anything that moves them is a change.
      // The layout files as well: a `git stash` can move only the map, and the page must adopt that, not save over it.
      const watched = storePaths.flatMap((path) => [path, layoutPathFor(path)]);
      const changes = createChangeFeed(watched, async () =>
        (await Promise.all(watched.map((path) => stat(path).then((info) => `${info.mtimeMs}:${info.size}`, () => "-")))).join("|"),
      );
      server.httpServer?.on("close", () => changes.close());
      server.middlewares.use("/api/changes", (_request, response) => {
        void changes.subscribe(response).catch(() => response.end());
      });
      // The search box (VIEW-25). This server has no database, and search is a Postgres query, so it builds one
      // from the plan files the first time someone searches - the same in-memory engine the MCP server runs, and
      // the same `searchFeed`, so the dev server matches exactly as the real hosts do rather than imitating them.
      // Lazily, because PGlite takes most of a second to start and most dev sessions never search.
      // One item for the detail pane (VIEW-29), from the same lazily-built database as search: the bulk feed below
      // no longer carries bodies or comments, so this server needs the per-item route the real hosts have.
      server.middlewares.use("/api/item", async (request, response) => {
        response.setHeader("Content-Type", "application/json");
        try {
          const { db, ownerId, itemFeed } = await searchable();
          const params = new URL(request.url ?? "/", "http://localhost").searchParams;
          const found = await itemFeed(db, ownerId, params.get("project") ?? "", params.get("ref") ?? "");
          if (found === null) response.statusCode = 404;
          response.end(JSON.stringify(found ?? { error: `no item "${params.get("ref") ?? ""}"` }));
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: `item failed: ${String(error)}` }));
        }
      });
      server.middlewares.use("/api/search", async (request, response) => {
        response.setHeader("Content-Type", "application/json");
        try {
          const { db, ownerId, searchFeed } = await searchable();
          const params = new URL(request.url ?? "/", "http://localhost").searchParams;
          const found = await searchFeed(db, ownerId, params.get("project") ?? "", params.get("q") ?? "");
          if (found === null) response.statusCode = 404;
          response.end(JSON.stringify(found ?? { error: `no project "${params.get("project") ?? ""}"` }));
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: `search failed: ${String(error)}` }));
        }
      });
      server.middlewares.use("/api/store", async (_request, response) => {
        response.setHeader("Content-Type", "application/json");
        try {
          // Parsed, not validated: the writer (importStore/saveStore) already enforces the schema, and a dev
          // server that refuses to serve a store the real server accepts would be a second source of truth.
          // Projected through the same `asPlan` the real server uses, though - the two routes must agree
          // about what a plan is, or the graph differs between `yarn viewer` and open_viewer (VIEW-15).
          // With each plan's layout file laid back over it (`VIEW-23.2`), so this server draws the same shared map.
          const loaded = await Promise.all(
            storePaths.map(async (path) => {
              const store = parse(await readFile(path, "utf8")) as Store;
              const layoutPath = layoutPathFor(path);
              return { path, store: existsSync(layoutPath) ? mergeLayout(store, parseLayout(await readFile(layoutPath, "utf8"))) : store };
            }),
          );
          const store = asPlan({ projects: loaded.flatMap(({ store: one }) => one.projects ?? []) });
          // Summarised from the month files rather than a database, because this server has none. The call is
          // one function for the same reason the other two hosts share `storeFeed`: the shape of this reply
          // must not be assembled by hand in three places (`METRIC-4`). Per store, because a reading lives
          // beside the plan that owns its subject; keyed by project key, so the results merge without
          // collision - two store files cannot hold the same project.
          const metrics = Object.assign(
            {},
            ...(await Promise.all(loaded.map(({ path, store: one }) => summariseFromFiles(path, (one.projects ?? []).map((project) => project.key))))),
          );
          // Each project's own plan file, relative to its repo (VIEW-48), the same as the real hosts send.
          const files = Object.fromEntries(loaded.flatMap(({ path, store: one }) => (one.projects ?? []).map((project) => [project.key, displayPath(path)])));
          response.end(JSON.stringify({ path: described, store, metrics, files }));
        } catch (error) {
          // Report it as data rather than crashing the request: a missing store is the ordinary first-run
          // state, and the viewer turns this message into something the user can act on.
          response.statusCode = 500;
          response.end(JSON.stringify({ error: `cannot read ${described}: ${String(error)}` }));
        }
      });
    },
  };
}

export default defineConfig({
  root: viewerRoot,
  plugins: [react(), servePlan()],
  server: {
    // 5176, not the 5175 this config was copied in with: the project it came from still runs its own viewer
    // there. strictPort makes a future collision fail loudly rather than letting Vite drift to another port,
    // which is how the e2e suite ended up testing a different application entirely.
    port: 5176,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
});
