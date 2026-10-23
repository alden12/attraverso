/**
 * The viewer, served by the MCP server itself (VIEW-12), so a user talking to Claude Desktop can be handed a
 * URL mid-conversation and see the graph of the project they are discussing.
 *
 * Why this process and not a second one: the browser cannot speak stdio MCP, and under Claude Desktop there is
 * no working directory to discover a store from (launchd starts the app at `/`), so the server process is the
 * only thing that knows which store is actually loaded. Serving from here means the viewer always renders the
 * store in use, wherever it lives - the thing the old build-time `?raw` inline could not do.
 *
 * Four constraints, each of which is a way this silently breaks:
 *
 * - **Bind `127.0.0.1`, never `0.0.0.0`.** Read-only does not mean public-safe: the plan is the whole
 *   project's thinking, and `0.0.0.0` would publish it to whatever network the laptop is on.
 * - **Bind lazily**, on the first `open_viewer` call rather than at boot, so a server that is only ever used
 *   for tool calls never squats a port.
 * - **Nothing may reach stdout.** An HTTP layer inside the MCP process logs to stderr only, or it corrupts the
 *   JSON-RPC stream: the same failure mode as the `yarn` and dotenv banners.
 * - **Serve from the live database**, not by re-reading the YAML. The write-through means the two agree, but
 *   reading the database keeps that an invariant rather than a race.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { attachments } from "../db/schema";
import { asPlan, exportStore, type StoreAccess } from "../serialise/store";
import { storeFeed } from "./storeFeed";
import { addAttachment, removeAttachment } from "../domain/attachments";
import { setStatus } from "../domain/items";
import { getProjectByKey } from "../domain/projects";
import type { Caller } from "./tools";
import { createFileMediaStore, mediaDirFor, unacceptable, type MediaStore } from "../media/store";
import { parseBody, readBody, ticketChange } from "./requests";

/** Above the dev server's 5176 so both can run at once (developing the viewer while a Desktop server is up). */
const FIRST_PORT = 5177;
const PORT_ATTEMPTS = 20;

/**
 * Where the built viewer lives, most-specific first. Three candidates because this module runs from three
 * places: from source under vite-node (`src/mcp/`, so the build is two levels up), from the ssr bundle at
 * `dist/server.js` (one level up), and from a self-contained distribution that carries the viewer beside the
 * bundle as `viewer/`. Settling on one packaged layout is `OPS-1`'s job.
 */
const VIEWER_BUILD_CANDIDATES = ["./viewer", "../../roadmap/dist", "../roadmap/dist"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * How long a served file may be cached, which is not a performance question here but a correctness one.
 *
 * Vite fingerprints every asset and references them from `index.html`, so an entry point that is allowed to go
 * stale points at hashes that no longer exist, and this server 404s them: the tab renders blank, with nothing
 * in the UI to explain it. That needs no exotic timing - rebuilding the viewer with a tab already open does
 * it, which happened during a session on 2026-07-29 and only missed by luck. An HTML response carrying no
 * cache directive at all is *not* uncached; browsers fall back to heuristic freshness, so this has to be said
 * explicitly.
 *
 * The inverse is safe for the same reason: a hashed filename is immutable by construction, so it can be
 * cached indefinitely and a rebuild simply asks for different names.
 */
const cacheFor = (requested: string): string =>
  requested.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable";

function findViewerBuild(): string | null {
  for (const candidate of VIEWER_BUILD_CANDIDATES) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(resolve(dir, "index.html"))) return dir;
  }
  return null;
}

/**
 * The token that makes this host writable (VIEW-17).
 *
 * A read-only loopback service is close to harmless. A writable one is not: `127.0.0.1` is reachable from any
 * page open in the same browser, so without this any website could POST into the user's plan. Two defences,
 * because either alone is thin:
 *
 * - **A secret in the URL.** Minted per process and handed out only through `open_viewer`, so a caller has to
 *   have been told it. It rides in the query string rather than the fragment, since a fragment never reaches
 *   the server.
 * - **A custom header on every mutation.** A cross-origin page cannot set one without a preflight, and the
 *   preflight is refused. That is what stops a form POST or an `img` tag from counting as a request.
 *
 * Reads stay open, deliberately. `<img src>` cannot carry a header, and the read surface is already public to
 * anything on the loopback interface via `/api/store`. Remote hosting changes that completely and is
 * `VIEW-14`/`MEDIA-2`'s problem, not something to half-solve here.
 */
const TOKEN_HEADER = "x-apm-token";


/**
 * Refuse a request that did not address us by our own name (VIEW-17).
 *
 * This is the DNS-rebinding defence, and it guards **reads as well as writes**, which the `Origin` check
 * below cannot. A page on `evil.com` whose DNS re-resolves to `127.0.0.1` is same-origin *with itself*, so
 * the browser applies no CORS at all and the response is readable - the classic attack on local services.
 * What the attacker cannot forge is `Host`: the browser sends the name it was asked for, so a rebound
 * request arrives saying `evil.com` and a genuine one says `127.0.0.1:<port>`.
 *
 * Without this, "a random tab cannot read your plan" is true only until someone controls a DNS record.
 */
function addressedToUs(request: IncomingMessage, port: number): boolean {
  const host = request.headers.host;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Same-origin only. A browser sends `Origin` on any cross-origin request, so an absent one is same-origin
 *  navigation and a present-but-foreign one is exactly what we are refusing. Narrower than `addressedToUs`
 *  and kept beside it: this one stops an ordinary cross-site write, that one stops a rebound read. */
function sameOrigin(request: IncomingMessage, port: number): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/** The attachment row for a hash, which is what makes the mime authoritative on the serving side rather than
 *  taken from the request. Scoped to no project deliberately: the hash IS the identity, and a loopback host
 *  serves one store. That stops being true remotely, which is `MEDIA-2`'s authorised-reads problem. */
async function attachmentByHash(db: Database, hash: string): Promise<{ hash: string; mime: string } | null> {
  const rows = await db.select({ hash: attachments.hash, mime: attachments.mime }).from(attachments).where(eq(attachments.hash, hash)).limit(1);
  return rows[0] ?? null;
}



export interface ViewerHost {
  /** Bind (once) and return the URL to hand the user, landing on `projectKey` and carrying the write token.
   *  Rejects with a readable message if it cannot. */
  open(projectKey: string): Promise<string>;
  /** Close the port if it was ever opened. */
  close(): Promise<void>;
}

/**
 * Where the host gets the things it cannot derive from the database.
 *
 * `media` is injected rather than built from a path, because the blob store is the one part of this host that
 * genuinely changes in the cloud: locally files under `.apm/media/`, at `OPS-11` an object store, and nothing
 * here should know which. The `MediaStore` interface has said so since `MEDIA-1`; this is the call site
 * finally honouring it.
 *
 * `storePath` is null when the database is the source of truth and there is no plan file at all. It is only
 * ever reported to the viewer for display, never read from, which is what makes null cheap.
 */
export interface ViewerSources {
  media: MediaStore;
  storePath: string | null;
}

/** The local arrangement: blobs beside the plan file. The default everywhere except database mode. */
export const fileSources = (storePath: string): ViewerSources => ({
  media: createFileMediaStore(mediaDirFor(storePath)),
  storePath,
});

/**
 * A lazily-bound loopback host for the viewer. Memoised: the second `open()` returns the same URL rather than
 * binding a second port, so asking twice in a conversation is free and the link stays stable.
 *
 * `caller` scopes it to one account's projects (`OPS-4`), the same way the tools are scoped. Fixed for the
 * life of the host rather than per-request, which is correct precisely because this host only exists in file
 * mode: it is bound to `127.0.0.1` for one person's checkout, and the cloud's `remoteViewerHost` refuses to
 * open at all. A hosted viewer serving several people is `VIEW-24`, and would need this per request.
 */
export function createViewerHost(db: Database, sources: ViewerSources, store: StoreAccess, caller: Caller): ViewerHost {
  let started: Promise<string> | null = null;
  let server: Server | null = null;
  let bound = 0;
  const token = randomBytes(24).toString("hex");
  const { media, storePath } = sources;

  type Reply = { status: number; type: string; body: string | Buffer; cache?: string };
  const json = (status: number, value: unknown): Reply => ({ status, type: MIME[".json"]!, body: JSON.stringify(value) });

  /**
   * The write surface, declared in one place and guarded before any route runs (VIEW-17).
   *
   * It was three identical copies of the same token and `Origin` checks, one inside each write route. That is
   * the shape where forgetting is invisible *and* the consequence is a hole rather than a wrong answer: a
   * fourth write route added later reads exactly like the others, ships without its guards, and nothing fails.
   *
   * Declaring the writes instead inverts it. A path listed here is guarded whichever branch below handles it,
   * and the risk moves from "did that route remember?" to "is this route in the table?" - which a test can ask
   * about every entry at once, and does.
   */
  const WRITES: { matches: (path: string) => boolean; method: string; hint: string }[] = [
    { matches: (p) => p === "/api/ticket", method: "POST", hint: "POST a change here" },
    { matches: (p) => p === "/api/media", method: "POST", hint: "POST an image here" },
    { matches: (p) => p.startsWith("/api/media/"), method: "DELETE", hint: "DELETE an attachment here" },
  ];

  /** Why this request may not write, or null to let it through. See `TOKEN_HEADER` for what each check stops. */
  const refuseWrite = (request: IncomingMessage, write: (typeof WRITES)[number]): Reply | null => {
    if (request.method !== write.method) return json(405, { error: write.hint });
    if (request.headers[TOKEN_HEADER] !== token) return json(403, { error: "missing or wrong write token" });
    if (!sameOrigin(request, bound)) return json(403, { error: "cross-origin writes are refused" });
    return null;
  };

  const handler = async (request: IncomingMessage): Promise<Reply> => {
    const raw = request.url ?? "/";
    const [path = "/", query = ""] = raw.split("?");
    const params = new URLSearchParams(query);

    // First, before any route: a request that did not name us is a rebinding attempt, and it is refused for
    // reads too - the read surface is the whole plan, which is the thing worth stealing.
    if (!addressedToUs(request, bound)) {
      return { status: 403, type: MIME[".html"]!, body: "this server only answers to 127.0.0.1" };
    }

    // Then, still before any route: if this path writes, it must be an authorised same-origin request of the
    // right method. Done here rather than inside each route so a new write cannot ship unguarded.
    const write = WRITES.find((candidate) => candidate.matches(path));
    if (write !== undefined) {
      const refused = refuseWrite(request, write);
      if (refused !== null) return refused;
    }

    // Pick up a foreign change to the plan before answering anything that touches it (IMP-10), so a graph
    // refreshed after a `git pull` shows the plan on disk rather than the one this process booted with. The
    // static assets below skip it: they are files, not state, and a page load asks for a dozen of them.
    if (path.startsWith("/api/") || path.startsWith("/media/")) await store.refresh();

    // The one dynamic read. Shape matches what the dev server serves at the same path, so the viewer is
    // identical in both cases and neither side is a special build.
    if (path === "/api/store") {
      // `asPlan`, not the raw export: this is a feed for rendering, and the export is the durable copy that
      // has to keep deleted rows. See its comment for why the two must not be the same document.
      const store = asPlan(await exportStore(db, caller.ownerId));
      // Assembled by `storeFeed`, not here, so this route and the hosted one cannot answer one path with two
      // shapes - which they did until `METRIC-4` added a field to only one of them. `uploadsDisabled` is a
      // reason rather than a boolean: whatever the viewer shows in the drop zone's place should be the
      // store's own words (`OPS-11`).
      return json(200, await storeFeed(db, caller.ownerId, { store, path: storePath, uploadsDisabled: media.unavailable ?? null }));
    }

    // Serve a blob. Open like the rest of the read surface, because `<img src>` cannot carry a header and
    // everything here is already loopback-only. The mime comes from the row rather than the request, so a
    // caller cannot talk us into serving a blob as something it is not.
    if (path.startsWith("/media/")) {
      const hash = path.slice("/media/".length);
      const row = await attachmentByHash(db, hash);
      if (row === null) return { status: 404, type: MIME[".html"]!, body: "no such attachment" };
      const bytes = await media.read(row.hash, row.mime);
      if (bytes === null) return { status: 404, type: MIME[".html"]!, body: "the blob for that attachment is missing" };
      // Immutable for the same reason a fingerprinted asset is: the name *is* the content (VIEW-16).
      return { status: 200, type: row.mime, body: Buffer.from(bytes), cache: "public, max-age=31536000, immutable" };
    }

    // Removing an attachment. Guarded by `WRITES` above, like every write - a DELETE is as destructive as a
    // POST, and rather more so from a page that only meant to render a graph.
    if (path.startsWith("/api/media/")) {
      try {
        const project = await getProjectByKey(db, caller.ownerId, params.get("project") ?? "");
        if (project === null) return json(404, { error: "no such project" });
        // The blob is deliberately left on disk; see removeAttachment for why a reference count is the wrong
        // thing to maintain here.
        const removed = await removeAttachment(db, project.id, path.slice("/api/media/".length), "user");
        await store.persist();
        return json(200, { hash: removed.hash });
      } catch (error) {
        return json(404, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    /**
     * Changing a ticket from the graph (VIEW-17).
     *
     * The route is `/api/ticket` rather than `/api/status` because the row is the thing being changed, and
     * `VIEW-19` adds title and body to this same handler as more fields in the same body. Settling that shape
     * on status first is deliberate: status is the one edit with no conflict story, so the request shape can
     * be agreed before `VIEW-18` adds a version to it.
     *
     * Status is validated against `STATUSES` rather than trusted, because this is the one write where the
     * client picks from a closed set: a bad value would otherwise reach the domain as a status nothing renders.
     */
    if (path === "/api/ticket") {
      try {
        const project = await getProjectByKey(db, caller.ownerId, params.get("project") ?? "");
        if (project === null) return json(404, { error: `no project "${params.get("project") ?? ""}"` });
        const change = await parseBody(request, ticketChange);
        const item = await setStatus(db, { projectId: project.id, ref: params.get("ref") ?? "", status: change.status }, "user");
        // The same write-through as a tool call, so a browser edit is durable the moment it is acknowledged
        // and passes the `IMP-13` guard rather than going around it.
        await store.persist();
        return json(200, { ref: item.ref, status: item.status, title: item.title });
      } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // The one write (VIEW-17). Every guard here is load-bearing; see TOKEN_HEADER above for why.
    if (path === "/api/media") {
      const projectKey = params.get("project") ?? "";
      const ref = params.get("ref") ?? undefined;
      const mime = (request.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";

      // Refused before the body is read, so a store that cannot hold the bytes does not make the browser
      // send them first (OPS-11). 501 rather than 4xx: nothing about the request is wrong, this deployment
      // just has nowhere to put it.
      if (media.unavailable !== undefined) return json(501, { error: media.unavailable });

      try {
        const project = await getProjectByKey(db, caller.ownerId, projectKey);
        if (project === null) return json(404, { error: `no project "${projectKey}"` });
        const data = await readBody(request);
        const refusal = unacceptable(mime, data.byteLength);
        if (refusal !== null) return json(415, { error: refusal });

        // Store first, then record. A failed attach therefore leaves a blob with no row - invisible, costs
        // disk, swept later (MEDIA-3). The reverse order would leave a row with no blob, which renders as a
        // broken image, so this fails towards the cheaper mistake rather than the visible one.
        const { hash, bytes } = await media.put(data, mime);
        const saved = await addAttachment(db, { projectId: project.id, ref, hash, mime, bytes }, "user");
        // The write-through IS the durability, exactly as for a tool call - and it goes through the same
        // IMP-13 guard, so a browser upload cannot clobber a store another process has changed either.
        await store.persist();
        return json(201, { hash: saved.hash, mime: saved.mime, bytes: saved.bytes, url: `/media/${saved.hash}` });
      } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    const root = findViewerBuild();
    if (root === null) {
      return {
        status: 503,
        type: MIME[".html"]!,
        body: "<h1>The viewer has not been built.</h1><p>Run <code>yarn viewer:build</code> in the repo, then reload.</p>",
      };
    }

    // Resolve inside the build directory and prove it stayed there: a static file server that skips this
    // serves `/../../.ssh/id_rsa` to anything that can reach the port.
    const requested = path === "/" ? "/index.html" : decodeURIComponent(path);
    const file = resolve(root, `.${requested}`);
    if (file !== root && !file.startsWith(root.endsWith(sep) ? root : root + sep)) {
      return { status: 403, type: MIME[".html"]!, body: "forbidden" };
    }
    if (!existsSync(file)) return { status: 404, type: MIME[".html"]!, body: "not found" };
    return { status: 200, type: MIME[extname(file)] ?? "application/octet-stream", body: await readFile(file), cache: cacheFor(requested) };
  };

  const listen = (candidate: Server, port: number): Promise<number> =>
    new Promise((fulfil, fail) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        candidate.removeListener("listening", onListening);
        fail(error);
      };
      const onListening = (): void => {
        candidate.removeListener("error", onError);
        fulfil(port);
      };
      candidate.once("error", onError);
      candidate.once("listening", onListening);
      candidate.listen(port, "127.0.0.1");
    });

  return {
    open(projectKey: string): Promise<string> {
      started ??= (async () => {
        // Checked before binding, so a missing build is an actionable tool error the model can relay rather
        // than a URL that opens onto an apology. The per-request lookup below stays as the backstop for a
        // build that disappears while the server is up.
        if (findViewerBuild() === null) {
          throw new Error("the viewer has not been built yet - run `yarn viewer:build` in the repo, then ask again");
        }

        const candidate = createServer((request, response) => {
          void handler(request)
            .then(({ status, type, body, cache }) => {
              // `no-store` is the default rather than the exception: the live store feed, the not-built
              // notice and the error pages must every one of them be re-fetched, and only a fingerprinted
              // asset is safe to keep. A response with no directive is not uncached, it is heuristically
              // cached, so silence here is a decision and the wrong one.
              response.writeHead(status, { "Content-Type": type, "Cache-Control": cache ?? "no-store" });
              response.end(body);
            })
            .catch((error: unknown) => {
              process.stderr.write(`viewer: ${request.url} failed: ${String(error)}\n`);
              response.writeHead(500, { "Content-Type": "text/plain" });
              response.end("internal error");
            });
        });

        // Walk up from the first free port: another project's server (or a stale one) holding 5177 should
        // move us along, not fail the tool call. Report the port actually bound, never the one asked for.
        let port: number | null = null;
        for (let candidatePort = FIRST_PORT; candidatePort < FIRST_PORT + PORT_ATTEMPTS; candidatePort++) {
          try {
            port = await listen(candidate, candidatePort);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
          }
        }
        if (port === null) throw new Error(`no free port in ${FIRST_PORT}-${FIRST_PORT + PORT_ATTEMPTS - 1}`);
        bound = port;

        server = candidate;
        process.stderr.write(`viewer listening on http://127.0.0.1:${bound}\n`);
        return `http://127.0.0.1:${bound}`;
      })().catch((error: unknown) => {
        started = null; // a failed bind must not be memoised, or every later call reports a stale failure
        throw error;
      });
      // The base URL is memoised; the token and the project ride on top, so asking for a second project does
      // not bind a second port. `?t=` is a query rather than a fragment because a fragment never reaches us.
      return started.then((base) => `${base}/?t=${token}#${projectKey}`);
    },

    close(): Promise<void> {
      const running = server;
      server = null;
      started = null;
      if (running === null) return Promise.resolve();
      return new Promise((fulfil) => running.close(() => fulfil()));
    },
  };
}
