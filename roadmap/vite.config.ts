import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { asPlan, resolveStorePaths, type Store } from "../src/serialise/store";
import { summariseFromFiles } from "../src/serialise/measurements";

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
 * as one graph here too. Any of them changing reloads the page, because the viewer's job is to show what the
 * plan currently is and it cannot know which file a reader is watching.
 *
 * The watcher restores what the `?raw` import gave for free: an edit to the YAML - by the MCP server writing
 * through, or by hand - reloads the open page. Refreshing in place, without losing the manual layout to a
 * reload, is VIEW-7.
 */
function servePlan(): Plugin {
  const storePaths = resolveStorePaths();
  const described = storePaths.join(", ");
  return {
    name: "apm-serve-store",
    configureServer(server: ViteDevServer) {
      for (const path of storePaths) server.watcher.add(path);
      server.watcher.on("change", (file) => {
        if (storePaths.includes(file)) server.ws.send({ type: "full-reload" });
      });
      server.middlewares.use("/api/store", async (_request, response) => {
        response.setHeader("Content-Type", "application/json");
        try {
          // Parsed, not validated: the writer (importStore/saveStore) already enforces the schema, and a dev
          // server that refuses to serve a store the real server accepts would be a second source of truth.
          // Projected through the same `asPlan` the real server uses, though - the two routes must agree
          // about what a plan is, or the graph differs between `yarn viewer` and open_viewer (VIEW-15).
          const loaded = await Promise.all(storePaths.map(async (path) => ({ path, store: parse(await readFile(path, "utf8")) as Store })));
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
          response.end(JSON.stringify({ path: described, store, metrics }));
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
