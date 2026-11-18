// The project's GitHub Pages site (`DIST-10`): for now the README as a page, at the site's root. The browser-only
// viewer (`DIST-9.1`) and its demo will sit beside it under their own paths, built into the same `_site/`.
//
// Plain JavaScript with one dependency, `marked`, rather than a `.ts` script under vite-node: the Pages workflow
// installs only that, not the whole workspace, so the site builds in seconds and nothing in it can depend on more.
//
// Run from the repo root, with the script copied beside a `marked` install (as `.github/workflows/pages.yml` does):
//   npm install --prefix /tmp/pages marked@15.0.12 && cp scripts/pages.mjs /tmp/pages/ && node /tmp/pages/pages.mjs _site
import { marked } from "marked";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const out = process.argv[2] ?? "_site";
const REPO = "https://github.com/alden12/attraverso";

/** Files the README shows, copied so its relative `src`s resolve on the site exactly as they do on GitHub. */
const ASSETS = ["roadmap/favicon.svg", "docs/screenshots"];

/**
 * A relative link the site does not serve (the licence, a doc) points at the file on GitHub instead, where it
 * renders. Anchors, absolute URLs and the copied assets are left alone.
 */
const SERVED = (path) => ASSETS.some((asset) => path === asset || path.startsWith(`${asset}/`));
const repoLink = (href) => (/^([a-z]+:|#|\/\/)/i.test(href) || SERVED(href) ? href : `${REPO}/blob/master/${href}`);

const readme = readFileSync("README.md", "utf8");
const html = marked
  .parse(readme, { gfm: true })
  .replace(/(<a\s[^>]*href=")([^"]+)"/g, (_, open, href) => `${open}${repoLink(href)}"`);

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>attraverso</title>
<meta name="description" content="Durable, structured project memory for AI coding agents, over MCP.">
<link rel="icon" href="roadmap/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.8.1/github-markdown.min.css">
<style>
  :root { color-scheme: light dark; --bg: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; } }
  body { margin: 0; background: var(--bg); }
  .markdown-body { box-sizing: border-box; max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; background: var(--bg); }
  .markdown-body img { max-width: 100%; height: auto; }
</style>
</head>
<body>
<main class="markdown-body">
${html}
<hr>
<p><a href="${REPO}">attraverso on GitHub</a> · <a href="https://www.npmjs.com/package/attraverso">on npm</a></p>
</main>
</body>
</html>
`;

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "index.html"), page);
for (const asset of ASSETS) {
  mkdirSync(dirname(join(out, asset)), { recursive: true });
  cpSync(asset, join(out, asset), { recursive: true });
}
console.log(`wrote ${out}/index.html and ${ASSETS.length} assets`);
