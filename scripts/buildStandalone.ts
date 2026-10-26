/**
 * The standalone build (OPS-7): one directory that runs with nothing installed but Node - no checkout, no
 * `node_modules`. It is what you hand to someone, and the input to the `.mcpb` bundle (OPS-8).
 *
 * Everything npm is inlined (`ssr.noExternal`), which leaves three kinds of file that are read from disk at
 * runtime and therefore have to be placed beside the bundle rather than compiled into it: PGlite's WASM
 * payload, the drizzle migrations, and the built viewer.
 *
 * **The placement is the whole difficulty, and it is not "next to the entry point".** PGlite locates its own
 * assets with `new URL("./pglite.wasm", import.meta.url)`, which resolves relative to *the chunk doing the
 * asking*. Whether that is the entry point or a split chunk under `assets/` depends on how rollup happened to
 * chunk the graph, which in turn depends on whether the import was static or dynamic. Getting it wrong
 * produces a build that succeeds and then fails at runtime with `ENOENT`, only once installed - the spike in
 * OPS-8 lost a cycle to exactly that. So this script does not assume: it finds the chunks that reference each
 * asset, copies the asset beside every one of them, and **fails the build if no chunk references it at all**,
 * which turns a silent runtime failure into a loud build-time one.
 */
import { build } from "vite";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(repoRoot, "standalone");
/** The published name (`DIST-5`). Italian for "through", and the one thing that was free everywhere. */
const PACKAGE_NAME = "attraverso";
// Found by resolution, not by path: in this package's own checkout PGlite is in `node_modules` beside it, but in
// the development workspace it is hoisted to the root's, and a fixed path is right in only one of the two.
// Its `exports` map does not expose `package.json`, so this resolves the main entry, which sits in `dist` beside
// the WASM payload.
const pgliteDist = dirname(createRequire(import.meta.url).resolve("@electric-sql/pglite"));
const viewerDist = join(repoRoot, "roadmap/dist");

/** Files read from disk at runtime, each keyed by the string the built code searches for them with. */
const RUNTIME_ASSETS = [
  { marker: "pglite.wasm", from: join(pgliteDist, "pglite.wasm"), as: "pglite.wasm" },
  { marker: "pglite.data", from: join(pgliteDist, "pglite.data"), as: "pglite.data" },
  { marker: "initdb.wasm", from: join(pgliteDist, "initdb.wasm"), as: "initdb.wasm" },
];

/** Every `.js` file in the output, so a reference can be found wherever rollup put it. */
async function chunks(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await chunks(path)));
    else if (entry.name.endsWith(".js")) found.push(path);
  }
  return found;
}

async function main(): Promise<void> {
  if (!existsSync(viewerDist)) {
    throw new Error(`no viewer build at ${relative(repoRoot, viewerDist)} - run \`yarn viewer:build\` first`);
  }
  await rm(outDir, { recursive: true, force: true });

  // noExternal is the difference from the ordinary `yarn build`: that one externalises every dependency and
  // needs node_modules at runtime, which is exactly what a handed-over folder cannot have.
  await build({
    root: repoRoot,
    configFile: false,
    logLevel: "warn",
    build: { ssr: "src/mcp/server.ts", outDir, emptyOutDir: true, target: "node22", minify: false },
    ssr: { noExternal: true, target: "node" },
  });

  const built = await chunks(outDir);
  const contents = new Map(await Promise.all(built.map(async (path) => [path, await readFile(path, "utf8")] as const)));

  for (const asset of RUNTIME_ASSETS) {
    const referencing = built.filter((path) => contents.get(path)?.includes(asset.marker));
    if (referencing.length === 0) {
      // Loud, because the alternative is a bundle that installs fine and dies on first use.
      throw new Error(
        `no built chunk references "${asset.marker}", so there is nowhere correct to put it. ` +
          `Either the dependency stopped needing it, or it is now loaded some other way - check before assuming this is safe to skip.`,
      );
    }
    for (const chunk of new Set(referencing.map(dirname))) {
      await cp(asset.from, join(chunk, asset.as));
    }
    console.error(`  ${asset.as} -> ${referencing.map((p) => relative(outDir, dirname(p)) || ".").join(", ")}`);
  }

  // The migrations are found the same way (`new URL("./migrations", import.meta.url)` in db/client.ts), so
  // they get the same treatment. DATA-15 removes this entirely by building the schema from the Drizzle
  // definitions instead of replaying a migration history there is no durable database to migrate.
  const migrationChunks = built.filter((path) => contents.get(path)?.includes("./migrations"));
  if (migrationChunks.length === 0) throw new Error('no built chunk references "./migrations" - see DATA-15 if this was removed deliberately');
  for (const chunk of new Set(migrationChunks.map(dirname))) {
    await cp(join(repoRoot, "src/db/migrations"), join(chunk, "migrations"), { recursive: true });
  }
  console.error(`  migrations -> ${migrationChunks.map((p) => relative(outDir, dirname(p)) || ".").join(", ")}`);

  // The viewer is found by mcp/viewer.ts, whose first candidate is `./viewer` beside the bundle - so unlike
  // the assets above, this location is ours to choose and is already agreed.
  await cp(viewerDist, join(outDir, "viewer"), { recursive: true });
  console.error("  viewer -> .");

  // The package's README is the repo's, because npm shows whatever README the published folder holds: this
  // was a generated README.txt describing the folder, and so it became the npm page. Its one relative link
  // still works there, since npm resolves those against `repository` below.
  await cp(join(repoRoot, "README.md"), join(outDir, "README.md"));

  // A publishable package, not just a handed-over folder (`DIST-5`). Generated rather than committed so it
  // cannot drift from the build that produced it, and so the version has exactly one home (`package.json` at
  // the repo root). The root package stays `private`; this is the only thing that is ever published.
  const root = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
    version: string;
    description?: string;
    license?: string;
    engines?: unknown;
  };
  await writeFile(
    join(outDir, "package.json"),
    `${JSON.stringify(
      {
        name: PACKAGE_NAME,
        version: root.version,
        description: root.description,
        license: root.license,
        // **The public mirror, never the development repo** (`DIST-3`). Development happens in a private repo,
        // and a link to it 404s for everyone who clicks it from npm. `alden12/attraverso` is the open core
        // exported from it, so that is where a reader can see the source and file an issue.
        repository: { type: "git", url: "git+https://github.com/alden12/attraverso.git" },
        homepage: "https://github.com/alden12/attraverso#readme",
        bugs: { url: "https://github.com/alden12/attraverso/issues" },
        type: "module",
        // Both names point at the one bundle: the full word is the package, the short one is what anyone
        // actually types. A bin name is a field here, not a registered thing, so the alias costs nothing.
        bin: { [PACKAGE_NAME]: "server.js", attra: "server.js" },
        engines: root.engines,
        // Everything in the directory ships: the WASM payload, the migrations and the viewer are all read
        // from disk at runtime, and a missing one is an ENOENT the user meets rather than the build does.
        files: ["server.js", "assets", "migrations", "viewer", "*.wasm", "pglite.data", "README.md", "LICENSE"],
      },
      null,
      2,
    )}\n`,
  );
  await cp(join(repoRoot, "LICENSE"), join(outDir, "LICENSE"));

  // `bin` entries are executed directly, so the entry chunk needs a shebang. Added here rather than in the
  // source, because the same file is imported as a module by the ordinary build and a shebang is not valid
  // TypeScript.
  const entry = join(outDir, "server.js");
  const bundled = await readFile(entry, "utf8");
  if (!bundled.startsWith("#!")) await writeFile(entry, `#!/usr/bin/env node\n${bundled}`);

  const size = await du(outDir);
  console.error(`standalone build ready: ${relative(repoRoot, outDir)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

async function du(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await du(path) : (await stat(path)).size;
  }
  return total;
}

await mkdir(outDir, { recursive: true });
main().catch((error: unknown) => {
  process.stderr.write(`build:standalone failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
