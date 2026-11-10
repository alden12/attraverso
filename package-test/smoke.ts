/**
 * The library as a consumer gets it (`DIST-6`): pack the standalone build exactly as `npm publish` would, install
 * the tarball into a scratch project outside the repo, and use it there - in Node, under a `NodeNext` type
 * check, and in a real browser.
 *
 * **Why this and not only the unit tests.** Those import the source. Every way the published library can break
 * is in what happens after that: the `exports` map, the `files` list, a dependency the build imports but the
 * manifest does not declare, a declaration file that resolves under `bundler` and not under `NodeNext`, a Node
 * import that a browser cannot load, PGlite's WASM going missing through someone else's bundler. Each of those
 * builds cleanly here and fails only once installed, so the only test that sees them is one that installs.
 *
 * The scratch project lives in the system temp directory, so nothing resolves back to this repo's
 * `node_modules` by walking up. Its dependencies come from the npm registry, as a real install's would.
 *
 *   yarn build:standalone && yarn test:package
 *
 * pglite's `nodefs.js` warns about `__vite-browser-external` during the browser build: that is PGlite's own Node
 * filesystem, reached only when given a path, and the warning is the same in any vite app that uses PGlite.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import { chromium } from "playwright";

const coreRoot = fileURLToPath(new URL("..", import.meta.url));
const standalone = join(coreRoot, "standalone");
// Resolved as Node would, not by a relative path: core sits at `packages/core` here and at the root of the public
// repo, so `../../../node_modules` only ever pointed at the right place from one of them.
const typescript = createRequire(import.meta.url).resolve("typescript/bin/tsc");

/**
 * What both runtimes do, as plain JavaScript so Node runs it as written and vite bundles it unchanged. Returns a
 * summary the caller compares against `EXPECTED`, so a failure says which step went wrong rather than "false".
 */
const SCENARIO = `
import { openPlan } from "attraverso/library";

export async function scenario() {
  const saves = [];
  const plan = await openPlan({ save: (yaml) => { saves.push(yaml); } });
  await plan.createProject({ key: "world", name: "A world", type: "world" });
  const world = await plan.project("world");
  const item = await world.createItem({ area: "NPC", title: "The ferryman", body: "Takes coins." });
  await world.addComment(item.ref, "Met at the river.");
  await world.setSection("Story so far", "It began at the river.");
  const hits = (await world.search("ferryman")).hits.map((h) => h.ref);
  await plan.close();

  // Reopen from what was saved: the round trip a reload of the page, or a restart of the program, depends on.
  const again = await openPlan({ yaml: saves.at(-1) });
  const reopened = await (await again.project("world")).getItem("NPC-1");
  const same = (await again.toYaml()) === saves.at(-1);
  await again.close();
  return { ref: item.ref, saves: saves.length, hits, body: reopened.body, comments: reopened.comments.map((c) => c.body), same };
}
`;

const EXPECTED = { ref: "NPC-1", saves: 4, hits: ["NPC-1"], body: "Takes coins.", comments: ["Met at the river."], same: true };

/** A use of every public type, compiled under the settings a Node project has, so a declaration that only
 *  resolves under \`bundler\` fails here. */
const TYPES = `
import { openPlan, type Plan, type PlanProject, type ItemDetail, type SearchResult } from "attraverso/library";

const plan: Plan = await openPlan({ yaml: "", save: async (yaml: string) => void yaml, actor: "smoke" });
const world: PlanProject = await plan.project("world");
const item: ItemDetail | null = await world.getItem("NPC-1");
const found: SearchResult = await world.search("x", { limit: 3 });
const ref: string | undefined = item?.comments[0]?.ref ?? undefined;
// @ts-expect-error - only the library is exported; the bundle's internals are not reachable
import("attraverso/server.js");
export { ref, found };
`;

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function check(where: string, actual: unknown): void {
  const got = JSON.stringify(actual);
  const want = JSON.stringify(EXPECTED);
  if (got !== want) throw new Error(`${where}: expected ${want}\n${" ".repeat(where.length + 2)}got      ${got}`);
  console.error(`  ${where}: ok`);
}

async function main(): Promise<void> {
  if (!existsSync(join(standalone, "lib", "index.js"))) throw new Error("no library in standalone/ - run `yarn build:standalone` first");
  // Resolved, because macOS's temp directory is a symlink (`/var` -> `/private/var`) and vite's HTML build then
  // names the page by a path relative to the other spelling, which rollup refuses as an asset name.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "attraverso-package-")));
  try {
    // 1. Pack and install, as a consumer would.
    const tarball = run("npm", ["pack", "--silent", "--pack-destination", scratch], standalone).trim().split("\n").at(-1)!;
    const project = join(scratch, "consumer");
    await mkdir(project);
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "consumer", private: true, type: "module", dependencies: { attraverso: `file:${join(scratch, tarball)}` } }, null, 2),
    );
    run("npm", ["install", "--silent", "--no-audit", "--no-fund"], project);
    console.error(`  installed ${tarball}`);

    // The `files` list carried what both halves of the package need.
    const installed = join(project, "node_modules", "attraverso");
    for (const required of ["server.js", "lib/index.js", "lib/index.d.ts", "pglite.wasm"]) {
      if (!existsSync(join(installed, required))) throw new Error(`the installed package has no ${required}`);
    }

    await writeFile(join(project, "scenario.js"), SCENARIO);

    // 2. Node.
    await writeFile(join(project, "node.js"), `import { scenario } from "./scenario.js";\nconsole.log(JSON.stringify(await scenario()));\n`);
    check("node", JSON.parse(run("node", ["node.js"], project)));

    // 3. Types, as a NodeNext project sees them.
    await writeFile(join(project, "types.ts"), TYPES);
    run("node", [typescript, "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--skipLibCheck", "false", "types.ts"], project);
    console.error("  types (NodeNext): ok");

    // 4. A browser, through a consumer's own vite build.
    await writeFile(
      join(project, "index.html"),
      `<!doctype html><script type="module">import { scenario } from "./scenario.js"; scenario().then((r) => { window.result = r; }, (e) => { window.result = { error: String(e && e.stack || e) }; });</script>`,
    );
    await build({ root: project, configFile: false, logLevel: "warn", build: { outDir: "dist", target: "es2022" } });
    const server = await preview({ root: project, configFile: false, logLevel: "warn", preview: { port: 0, host: "127.0.0.1" } });
    // `CHROMIUM_PATH` for a machine whose Chromium is not the one this Playwright version downloads (a cloud
    // session has one preinstalled); unset, Playwright uses its own, as `test:e2e` does.
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    try {
      const url = server.resolvedUrls?.local[0];
      if (url === undefined) throw new Error("vite preview reported no URL");
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => (window as unknown as { result?: unknown }).result !== undefined, undefined, { timeout: 60_000 });
      const result = await page.evaluate(() => (window as unknown as { result: unknown }).result);
      if (errors.length > 0) throw new Error(`browser: the page threw\n${errors.join("\n")}`);
      check("browser", result);
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
    }

    const assets = (await readdir(join(project, "dist", "assets"))).filter((name) => name.endsWith(".wasm"));
    console.error(`  browser bundle carried ${assets.join(", ") || "no wasm"}`);
    console.error("package smoke test passed");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`test:package failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
