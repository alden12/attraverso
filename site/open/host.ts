/**
 * The viewer's server, in the page (`DIST-9.1`): the plan from a folder loaded into an in-browser Postgres
 * (PGlite, as everywhere else), and the viewer's `/api` reads answered from it by the same feed functions the
 * loopback host and the hosted server use, so this is a third host that cannot drift from the other two.
 *
 * **Read only.** Every write route is refused with a reason, and the viewer, finding no write credential
 * (`canWrite`), does not offer them. A layout dragged here stays in this browser, as on any host that cannot write.
 *
 * Answered by wrapping `fetch` for `/api/` paths rather than by a service worker: the plan lives in this page's
 * memory, and a worker would need its own copy. The viewer's requests are same-origin and path-absolute, so they
 * are recognised by path wherever the site is served from (`/attraverso/open/` on Pages).
 */
import { createInMemoryDb } from "../../src/db/memory";
import type { Database } from "../../src/db/client";
import { asPlan, importStore, mergeLayout, mergeReferences, parseLayout, parseReferences, parseStore, replaceStore, type Store } from "../../src/serialise/plan";
import { ensureUser, LOCAL_IDENTITY } from "../../src/domain/users";
import { storeFeed } from "../../src/mcp/storeFeed";
import { itemFeed } from "../../src/mcp/itemFeed";
import { searchFeed } from "../../src/mcp/searchFeed";
import type { FolderRead } from "./folder";

export const READ_ONLY = "This page opens the plan read-only: edit it with your agent, and the page follows.";

/** The folder's plans as one store, each with its layout and references laid back over it, as the server reads it. */
export function storeOf(read: FolderRead): Store {
  return {
    projects: read.plans.flatMap((files) => {
      let store = parseStore(files.plan);
      if (files.layout !== null) store = mergeLayout(store, parseLayout(files.layout));
      if (files.references !== null) store = mergeReferences(store, parseReferences(files.references));
      return store.projects;
    }),
  };
}

export interface PageHost {
  /** Load a newer read of the folder in place: the same database, its contents replaced. */
  reload(read: FolderRead): Promise<void>;
}

/** Load the folder's plan and start answering the viewer's requests from it. */
export async function startHost(first: FolderRead): Promise<PageHost> {
  const { db } = await createInMemoryDb();
  await importStore(db, storeOf(first));
  const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);
  let read = first;
  let store = storeOf(first);

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const answer = async (url: URL, method: string): Promise<Response> => {
    if (method !== "GET") return json({ error: READ_ONLY }, 403);
    const param = (name: string) => url.searchParams.get(name) ?? "";
    switch (url.pathname.replace(/^.*(?=\/api\/)/, "")) {
      case "/api/store": {
        const files = Object.fromEntries(read.plans.flatMap((p) => parseStore(p.plan).projects.map((project) => [project.key, `${read.folder}/${p.name}`])));
        return json(await storeFeed(db as Database, ownerId, { store: asPlan(store), path: read.folder, uploadsDisabled: READ_ONLY, files }));
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

  return {
    reload: async (next) => {
      read = next;
      store = storeOf(next);
      await replaceStore(db, store);
    },
  };
}
