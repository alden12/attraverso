/**
 * Serving the two browser builds - the consent page and the viewer - from the hosted server (`VIEW-24`).
 *
 * Its own module so the traversal guard can be tested: `http.ts` calls `main()` at import, so nothing declared
 * there is reachable from a test. The same split `OPS-3` made for `runtime.ts`, for the same reason.
 */
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};


/**
 * How long a served file may be cached, which is a correctness question rather than a performance one.
 *
 * Vite fingerprints every asset and names them from `index.html`, so an entry point allowed to go stale points
 * at hashes that no longer exist and the page renders blank with nothing to explain it. Deploying with a tab
 * already open is enough to cause it. An HTML response carrying no cache directive is *not* uncached - browsers
 * fall back to heuristic freshness - so it has to be said. The inverse is safe for the same reason: a hashed
 * name is immutable by construction. Same rule as the loopback host (`VIEW-16`).
 */
export const cacheFor = (file: string): string =>
  file.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable";

/**
 * Serve one file from a build directory, or null when there is no such file.
 *
 * The path is normalised and then checked to still be *inside* the directory, which is the guard against a
 * request like `/oauth/../../etc/passwd` walking out of it. Checking the resolved path rather than filtering
 * the request string is what makes that robust: there is one way in, and it is the same one the filesystem
 * would take.
 *
 * One function for both builds, because two copies of a traversal check is how one of them ends up subtly
 * weaker - and this is the file where the consequence is reading anything on the machine.
 */
export async function serveFile(
  dir: string,
  relative: string,
): Promise<{ body: Buffer; type: string; cache: string } | null> {
  const resolved = normalize(join(dir, relative));
  if (resolved !== dir && !resolved.startsWith(dir + sep)) return null;
  try {
    return {
      body: await readFile(resolved),
      type: MIME[extname(resolved)] ?? "application/octet-stream",
      cache: cacheFor(resolved),
    };
  } catch {
    return null;
  }
}
