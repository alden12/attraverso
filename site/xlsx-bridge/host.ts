/**
 * The viewer's server, in the page (`DIST-9.1`): the plan read from the spreadsheet loaded into an in-browser
 * Postgres (PGlite, as everywhere else), and the viewer's `/api` reads answered from it by the same feed functions
 * the loopback host and the hosted server use, so this is a third host that cannot drift from the other two.
 *
 * **Read only.** Every write route is refused with a reason, and the viewer, finding no write credential
 * (`canWrite`), does not offer them. A layout dragged here stays in this browser, as on any host that cannot write.
 *
 * Answered by wrapping `fetch` for `/api/` paths rather than by a service worker: the plan lives in this page's
 * memory, and a worker would need its own copy. The viewer's requests are same-origin and path-absolute, so they
 * are recognised by path wherever the site is served from (`/attraverso/xlsx-bridge/` on Pages).
 */
import { createInMemoryDb } from "../../src/db/memory";
import type { Database } from "../../src/db/client";
import { asPlan, importStore, replaceStore, type Store } from "../../src/serialise/plan";
import { uuidv7 } from "../../src/db/ids";
import { ensureUser, LOCAL_IDENTITY } from "../../src/domain/users";
import { storeFeed } from "../../src/mcp/storeFeed";
import { itemFeed } from "../../src/mcp/itemFeed";
import { searchFeed } from "../../src/mcp/searchFeed";
import { readPlan, type Problem } from "../workbook/model";
import { readWorkbook } from "../workbook/xlsx";
import type { SheetRead } from "./file";

export const READ_ONLY = "This page only reads the spreadsheet and never changes it: edit the spreadsheet, and the page follows.";

/** The same id for the same ref on every read, so a reload changes items rather than replacing them. */
const ids = new Map<string, string>();
const idOf = (key: string): string => {
  if (!ids.has(key)) ids.set(key, uuidv7());
  return ids.get(key)!;
};

/** The plan and its problems, from the file's bytes. */
export async function planOf(read: SheetRead): Promise<{ store: Store; problems: Problem[] }> {
  return readPlan(await readWorkbook(read.bytes), read.name, new Date(read.modified).toISOString(), idOf);
}

export interface PageHost {
  /** Load a newer read of the file in place: the same database, its contents replaced. Returns its problems. */
  reload(read: SheetRead): Promise<Problem[]>;
  problems: Problem[];
}

/** Load the spreadsheet's plan and start answering the viewer's requests from it. */
export async function startHost(first: SheetRead): Promise<PageHost> {
  const { db } = await createInMemoryDb();
  let read = first;
  let { store, problems } = await planOf(first);
  await importStore(db, store);
  const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const answer = async (url: URL, method: string): Promise<Response> => {
    if (method !== "GET") return json({ error: READ_ONLY }, 403);
    const param = (name: string) => url.searchParams.get(name) ?? "";
    switch (url.pathname.replace(/^.*(?=\/api\/)/, "")) {
      case "/api/store": {
        const files = Object.fromEntries(store.projects.map((project) => [project.key, `${read.name}.xlsx`]));
        return json(await storeFeed(db as Database, ownerId, { store: asPlan(store), path: `${read.name}.xlsx`, uploadsDisabled: READ_ONLY, files }));
      }
      case "/api/item": {
        const found = await itemFeed(db as Database, ownerId, param("project"), param("ref"));
        return found === null ? json({ error: `no item "${param("ref")}"` }, 404) : json(found);
      }
      case "/api/search": {
        const found = await searchFeed(db as Database, ownerId, param("project"), param("q"));
        return found === null ? json({ error: `no project "${param("project")}"` }, 404) : json(found);
      }
      default:
        return json({ error: `${url.pathname} is not served here` }, 404);
    }
  };

  const network = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input), window.location.href);
    if (url.origin === window.location.origin && /\/api\//.test(url.pathname)) {
      try {
        return await answer(url, (init?.method ?? request?.method ?? "GET").toUpperCase());
      } catch (error) {
        return json({ error: String(error) }, 500);
      }
    }
    return network(input, init);
  };

  const host: PageHost = {
    problems,
    reload: async (next) => {
      read = next;
      ({ store, problems } = await planOf(next));
      await replaceStore(db, store);
      host.problems = problems;
      return problems;
    },
  };
  return host;
}
