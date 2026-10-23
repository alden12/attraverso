// From vitest/config, not vite: it is the same defineConfig widened to accept the `test` block below.
import { defineConfig } from "vitest/config";

/**
 * The Node side: the MCP server's distributable bundle, and the vitest config the domain tests run under.
 * The viewer keeps its own config (roadmap/vite.config.ts) because its root, plugins and fs allow-list are
 * all different - it is a browser app, this is not.
 *
 * `better-sqlite3` is a native module, so it stays external: bundling a `.node` binary is neither possible
 * nor useful. Claude Desktop runs the built `dist/server.js` rather than vite-node, so a session's startup
 * cost is a plain node process rather than a dev-time transform.
 */
export default defineConfig({
  build: {
    ssr: "src/mcp/server.ts",
    outDir: "dist",
    target: "node22",
    rollupOptions: { external: ["better-sqlite3"] },
  },
  test: {
    environment: "node",
    // roadmap/ is a browser app, but the pieces worth testing there are pure functions over the fetched store
    // (which project to render, VIEW-4), so they run here under node rather than needing a DOM.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "roadmap/**/*.test.ts"],
    // Drops the throwaway databases the Postgres target creates, before and after the run. A no-op for the
    // default PGlite run. It lives here rather than in a test hook because it has to hold whatever an
    // interrupted run left behind, which no per-test cleanup can (OPS-2).
    globalSetup: ["src/db/globalSetup.ts"],
    /**
     * Vitest's default is 10s, which is sized for trivial setup. Several suites here boot a WASM Postgres in
     * `beforeAll`, seed it through the real domain path (transactions plus event-log rows) and, in
     * `viewer.test.ts`, bind an HTTP port on top - a second or two locally, and CI ran the same suite in
     * roughly twice the wall-clock with far less parallelism, which put that hook over the line once.
     *
     * Raised rather than re-run, because a re-run only re-rolls the dice: the hook is doing real work and
     * 10s was never a budget anyone chose for it. 30s is still short enough that a genuine hang fails the
     * build promptly rather than sitting in a queue.
     */
    hookTimeout: 30_000,
    /**
     * The same argument, for the test body. Vitest defaults it to 5s, and a `freshDb()` that finds the pool
     * empty boots a WASM Postgres and replays every migration - ~0.6s locally and **~2.6s on a CI runner**
     * (measured in `PLAT-6`). A test doing that plus real work is inside 5s on a laptop and marginal on CI,
     * which is how `store.test.ts` timed out on a case that asserts one field of an exported item.
     *
     * The failure was never about that test. Any test whose turn it is to boot pays the same, so the tight
     * budget is a flake generator sitting under the whole suite, and a re-run only re-rolls it. 30s matches
     * the hook and is still short enough that a genuine hang fails promptly.
     */
    testTimeout: 30_000,
  },
});
