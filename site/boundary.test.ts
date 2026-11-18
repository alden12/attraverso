/**
 * `site/` is the Pages site's alone (`DIST-10`): the workbook round trip (`DIST-9.2`) and, later, the browser-only
 * viewer pages. The published package is built from `src/` and the viewer in `roadmap/`, and the cloud server
 * imports core's `src/`, so as long as nothing there imports from `site/`, none of it ships anywhere but the site.
 * This holds that line, so it does not rest on someone remembering it.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const core = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("site/ stays out of everything else (DIST-10)", () => {
  it("is imported by nothing in src/, roadmap/ or scripts/", () => {
    const crossing = ["src", "roadmap", "scripts"]
      .flatMap((dir) => sources(join(core, dir)))
      .filter((file) => /from\s+["'][^"']*\/site\//.test(readFileSync(file, "utf8")) || /import\(["'][^"']*\/site\//.test(readFileSync(file, "utf8")))
      .map((file) => relative(core, file));
    expect(crossing).toEqual([]);
  });
});
