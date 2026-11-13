/**
 * `GET /api/changes` (`VIEW-7`): the plan's version token, pushed to an open viewer as server-sent events whenever
 * the plan files change, so a change Claude just made - or a `git pull`, a branch switch, a hand edit - shows up
 * without a reload. **A notification, never the data**: the page refetches `/api/store` when the token moves, so
 * there is one loading path, and a missed or coalesced change corrects itself on the next one.
 *
 * **Pushed by a watcher rather than polled**, and only on a local host. The first cut polled a version route every
 * four seconds, which worked and was cheap, but on the hosted server an open tab polling forever would keep a
 * scaled-to-zero machine awake; a push there needs a fan-out between machines and is its own piece of work. Here
 * there is one process and the files are on its disk, so a watcher is the honest source.
 *
 * - **The folder is watched, not the file.** Git replaces a file by renaming over it, and so does this server's own
 *   write-through (temp + rename), and a watch on the file itself goes deaf after the first rename. Events are
 *   filtered to the plan files' names.
 * - **One watcher covers every kind of write**, the server's own included, since a tool call's write-through lands
 *   in the same folder. Nothing has to remember to announce.
 * - **Bursts settle into one announcement** (`SETTLE_MS`): a branch switch rewrites both plan files, and an agent
 *   working through a list writes a dozen times in a few seconds. The token only goes out when it moved, so the
 *   viewer's own layout saves (which the token ignores) and a touch that changes nothing announce nothing.
 * - **Nothing runs without a listener.** The watchers start with the first connected page and close with the last,
 *   and a heartbeat comment finds a page that vanished without closing its connection.
 */
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { ServerResponse } from "node:http";

const SETTLE_MS = 150;
const HEARTBEAT_MS = 30_000;

export interface ChangeFeed {
  /** Hold `response` open as an event stream, starting with the current token. */
  subscribe(response: ServerResponse): Promise<void>;
  /** Check the token now (after the settle) and announce it if it moved. The watcher calls this; so may a test. */
  poke(): void;
  /** How many pages are listening. */
  listeners(): number;
  close(): void;
}

/**
 * `paths` are the files to watch, and `version` reads the token: on the loopback host that refreshes the store from
 * disk first (`IMP-10`) and reads the latest event, on the dev server it is the files' modification times.
 */
export function createChangeFeed(paths: readonly string[], version: () => Promise<string>, settleMs = SETTLE_MS): ChangeFeed {
  const clients = new Set<ServerResponse>();
  let watchers: FSWatcher[] = [];
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let announced: string | null = null;

  const send = (response: ServerResponse, token: string) => response.write(`event: version\ndata: ${token}\n\n`);

  const check = async () => {
    try {
      const token = await version();
      if (token === announced) return;
      announced = token;
      for (const client of clients) send(client, token);
    } catch (error) {
      // A half-written file mid-checkout, say: the write that finishes it pokes again.
      process.stderr.write(`viewer: change check failed: ${String(error)}\n`);
    }
  };

  const poke = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, settleMs);
  };

  const start = () => {
    const names = new Set(paths.map((path) => basename(path)));
    for (const folder of new Set(paths.map((path) => dirname(path)))) {
      try {
        const watcher = watch(folder, (_kind, name) => {
          if (name === null || names.has(basename(name.toString()))) poke();
        });
        watcher.on("error", () => {}); // a folder deleted under us: nothing left to watch, and no reason to crash
        watchers.push(watcher);
      } catch {
        // A folder that is not there: no changes to report from it.
      }
    }
    heartbeat = setInterval(() => {
      for (const client of clients) client.write(": ping\n\n");
    }, HEARTBEAT_MS);
  };

  const stop = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    async subscribe(response) {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      const token = await version();
      announced ??= token;
      // The page compares this first token with the plan it holds and refetches if they differ, which is how a
      // change made while its tab was hidden (and its stream closed) still arrives.
      send(response, token);
      if (clients.size === 0) start();
      clients.add(response);
      response.on("close", () => {
        clients.delete(response);
        if (clients.size === 0) stop();
      });
    },
    poke,
    listeners: () => clients.size,
    close() {
      for (const client of clients) client.end();
      clients.clear();
      stop();
    },
  };
}
