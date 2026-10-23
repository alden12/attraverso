/**
 * That the file-backed server never statically imports the Postgres driver.
 *
 * This guards a failure with the worst possible shape: **invisible in development, fatal in the artefact we
 * ship**. Under `vite-node` an eager `pg` import is harmless, because Node's ESM interop tolerates the
 * circular CommonJS namespace it produces. Bundled, Rollup emits a getter that self-references before
 * initialisation, and the server dies at load with `Cannot access 'pg' before initialization` - so every test
 * passes, `yarn verify` is green, and `apm` cannot start from the standalone bundle at all. Which is how it is
 * meant to be used on a project that is not this one.
 *
 * It cost the project twice before it was understood. `OPS-3` hit it while bundling the hosted server and
 * recorded "pg cannot be inlined", abandoning a 750ms cold-start win; it was really "pg cannot be inlined into
 * a path that does not use it". Then it stopped a second project from running the bundle at all (2026-08-31).
 *
 * The check walks the *static* import graph from the stdio entry point and asserts the driver is not in it.
 * `runtime.ts` reaches it through `await import(...)` on the Postgres branch, which this deliberately does not
 * follow - a dynamic import is precisely the thing being verified, so counting it would defeat the test.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Modules that must not be reachable without an explicit dynamic import. */
const FORBIDDEN = ["pg", "drizzle-orm/node-postgres", "drizzle-orm/node-postgres/migrator"];

/**
 * Every `import ... from "x"` and `export ... from "x"` at the top level of a file.
 *
 * Regex rather than a parser, and honest about it: a bundler is the only thing that knows for certain, so
 * this is a cheap approximation of one. It matches the static forms and nothing else, which is exactly the
 * distinction the test turns on - `await import("...")` has no `from`, so it cannot match.
 */
function staticImports(source: string): string[] {
  return [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
}

/** Resolve a relative specifier to a real file, trying the extensions this project uses. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
  }
  return null;
}

/** Every file reachable from `entry` by static imports, and every bare specifier they name. */
function eagerGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of staticImports(readFileSync(file, "utf8"))) {
      const local = resolveLocal(file, specifier);
      if (local === null) packages.add(specifier);
      else queue.push(local);
    }
  }
  return { files, packages };
}

describe("the file-backed server's eager module graph", () => {
  it("does not reach the Postgres driver", () => {
    const { packages } = eagerGraph(resolve(SRC, "mcp/server.ts"));
    expect([...packages].filter((name) => FORBIDDEN.includes(name))).toEqual([]);
  });

  it("does reach the embedded engine, so the walk is finding real edges", () => {
    // Without this, a walk that silently found nothing would pass the test above for the wrong reason.
    const { packages, files } = eagerGraph(resolve(SRC, "mcp/server.ts"));
    expect(packages).toContain("@electric-sql/pglite");
    expect([...files].some((f) => f.endsWith("db/client.ts"))).toBe(true);
  });

  it("still reaches the driver from the module that owns it", () => {
    // The driver has not simply been deleted: importing `db/postgres.ts` directly gets you Postgres, which is
    // what the hosted server and the migration scripts do.
    const { packages } = eagerGraph(resolve(SRC, "db/postgres.ts"));
    expect(packages).toContain("pg");
  });
});
