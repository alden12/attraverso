import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The project's GitHub Pages site (`DIST-10`): a React app built with the viewer's toolchain, so the browser-only
// viewer (`/open`) and its demo (`/demo`, `DIST-9.1`) can join it as further pages of the same build, sharing code.
//
// `base: "./"`: every URL relative, because Pages serves the site under `/attraverso/`, and a relative base works
// there, at a custom domain's root and from `vite preview` alike, with nothing to configure per host.
const siteRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  root: siteRoot,
  base: "./",
  plugins: [react()],
  // The README and the images it shows live at the repo root, outside this folder.
  server: { fs: { allow: [repoRoot] } },
  build: { outDir: "dist", emptyOutDir: true },
});
