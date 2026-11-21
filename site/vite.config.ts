import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The project's GitHub Pages site (`DIST-10`): a React app built with the viewer's toolchain, so the browser-only
// viewer (`/xlsx-bridge`) and its demo (`/demo`, `DIST-9.1`) can join it as further pages of the same build, sharing code.
//
// `base: "./"`: every URL relative, because Pages serves the site under `/attraverso/`, and a relative base works
// there, at a custom domain's root and from `vite preview` alike, with nothing to configure per host.
const siteRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  root: siteRoot,
  base: "./",
  plugins: [react()],
  // The README and the images it shows live at the package root, outside this folder; PGlite's WebAssembly is in
  // the workspace's hoisted node_modules, above that, and without it the dev server answers the bridge's database with
  // an error page.
  //
  // No websocket under the e2e suite (`E2E_NO_WS`, set in `playwright.config.ts`): Vite's client reloads the whole page
  // whenever its socket drops, a missed ping on a busy machine included, and a reload mid-test throws away what the
  // test had open (a local check once lost the viewer's menu that way). Nothing the pages do needs it.
  server: { fs: { allow: [repoRoot, searchForWorkspaceRoot(process.cwd())] }, ws: process.env.E2E_NO_WS ? false : undefined },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Two pages: the home page, and `/xlsx-bridge`, the viewer on a plan spreadsheet (`DIST-9.1`), which alone loads PGlite.
    rollupOptions: { input: { index: `${siteRoot}index.html`, bridge: `${siteRoot}xlsx-bridge/index.html` } },
  },
  // PGlite fetches its own WebAssembly and data bundle beside its module, which pre-bundling would break.
  optimizeDeps: { exclude: ["@electric-sql/pglite"] },
});
