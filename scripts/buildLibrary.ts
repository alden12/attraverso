/**
 * The in-process library's build (`DIST-6`): `src/library/index.ts` as an ES module plus one self-contained
 * `.d.ts`, placed in the standalone package under `lib/` and published beside the server bundle.
 *
 * **Its dependencies stay external, unlike the bundle's.** The server is one folder that runs with nothing
 * installed; a library is imported into someone else's build, and that build is the right place to resolve
 * PGlite. Bundling PGlite here would mean either inlining its WASM as base64 (vite's library mode inlines every
 * asset) or placing it beside our chunks, which a consumer's bundler would not know to copy. Left external, the
 * consumer's bundler handles PGlite as it handles any install of it. The cost is that the published package
 * gains `dependencies`: this returns the ones the build actually imports, versions taken from `package.json`,
 * and fails if it imports one that is not declared there.
 *
 * **The types are one file, or the build fails.** The entry declares every public type itself, so its emitted
 * declaration needs nothing else; tsc's output is checked for any `import`, because a declaration that pulled
 * in `../domain/items` would resolve under a bundler and break under `NodeNext`, which is what a Node project
 * using the package typically has.
 *
 * **And the build must not import Node.** Checked on the output for the same reason the asset placement in
 * `buildStandalone.ts` is: the mistake builds cleanly and fails only in a browser, the one place nobody here
 * runs it by hand.
 */
import { build } from "vite";
import ts from "typescript";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const coreRoot = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(coreRoot, "src/library/index.ts");

/** `drizzle-orm/pg-core` -> `drizzle-orm`; `@electric-sql/pglite/x` -> `@electric-sql/pglite`. */
const packageOf = (specifier: string): string => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

const isBare = (id: string): boolean => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0") && !/^[A-Za-z]:/.test(id);

/** Build into `<outDir>/lib`, returning the `dependencies` the published package must declare. */
export async function buildLibrary(outDir: string): Promise<Record<string, string>> {
  const libDir = join(outDir, "lib");
  const manifest = JSON.parse(await readFile(join(coreRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> };

  const imported = new Set<string>();
  await build({
    root: coreRoot,
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: libDir,
      emptyOutDir: true,
      target: "es2022",
      minify: false,
      lib: { entry: ENTRY, formats: ["es"], fileName: () => "index.js" },
      rollupOptions: {
        external: (id) => {
          if (!isBare(id)) return false;
          if (id.startsWith("node:")) throw new Error(`the library imports ${id}, so it cannot run in a browser`);
          imported.add(packageOf(id));
          return true;
        },
      },
    },
  });

  const dependencies: Record<string, string> = {};
  for (const name of [...imported].sort()) {
    const version = manifest.dependencies[name];
    if (version === undefined) throw new Error(`the library imports ${name}, which is not in package.json's dependencies`);
    dependencies[name] = version;
  }

  // Belt and braces over the `external` check above: a Node builtin imported without the `node:` prefix
  // (`"fs"`) would have passed it as a bare package name.
  const js = (await Promise.all((await readdir(libDir)).filter((name) => name.endsWith(".js")).map((name) => readFile(join(libDir, name), "utf8")))).join("\n");
  const builtin = [...js.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!).find((id) => builtinModules.includes(id));
  if (builtin !== undefined) throw new Error(`the library imports ${builtin}, a Node builtin, so it cannot run in a browser`);

  await writeFile(join(libDir, "index.d.ts"), declarations());
  return dependencies;
}

/** The entry's declaration, emitted with the package's own compiler options and checked to stand alone. */
function declarations(): string {
  const configPath = join(coreRoot, "tsconfig.json");
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); } });
  if (config === undefined) throw new Error(`could not read ${configPath}`);
  const program = ts.createProgram([ENTRY], { ...config.options, noEmit: false, declaration: true, emitDeclarationOnly: true });

  const errors = ts.getPreEmitDiagnostics(program);
  if (errors.length > 0) throw new Error(ts.formatDiagnostics(errors, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => coreRoot, getNewLine: () => "\n" }));

  let emitted: string | undefined;
  program.emit(program.getSourceFile(ENTRY), (name, text) => {
    if (name.endsWith("library/index.d.ts")) emitted = text;
  }, undefined, true);
  if (emitted === undefined) throw new Error("tsc emitted no declaration for the library entry");
  const reaching = emitted.split("\n").filter((line) => /^\s*(import|export .* from)\b/.test(line));
  if (reaching.length > 0) {
    throw new Error(`the library's declaration imports other modules, so it would not resolve for a consumer:\n${reaching.join("\n")}\nDeclare the type in src/library/index.ts instead.`);
  }
  return emitted;
}

// Run directly (`vite-node scripts/buildLibrary.ts`), it builds into the standalone folder on its own.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outDir = join(coreRoot, "standalone");
  await mkdir(outDir, { recursive: true });
  console.error(await buildLibrary(outDir));
}
