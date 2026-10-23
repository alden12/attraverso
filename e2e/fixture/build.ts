/**
 * Builds the store the end-to-end suite renders (`DIST-2`): `demo.apm.yaml` and `other.apm.yaml`.
 *
 * The suite used to render this repo's own plan, which kept its numbers honest as the backlog grew. That plan is
 * private and stays outside the package (`DIST-3`), so the open core needs a store of its own. It is generated
 * here through the domain layer rather than written by hand, so it is a file the tools could have written -
 * canonical layout, real ids, valid references - and so it can be rebuilt rather than hand-maintained:
 *
 *   yarn vite-node e2e/fixture/build.ts
 *
 * It carries one of each thing the suite asserts on: several areas, a nested item (a parent drawn as a box),
 * dependencies with prose to navigate, a soft-deleted item the viewer must not count, and dependencies naming
 * a second project, which is a second file here as it is in a real split plan (`PROJ-11`).
 */
import { fileURLToPath } from "node:url";
import { createInMemoryDb } from "../../src/db/client";
import { createItem, deleteItem, setStatus } from "../../src/domain/items";
import { createProject } from "../../src/domain/projects";
import { ensureUser, LOCAL_IDENTITY } from "../../src/domain/users";
import { saveStore } from "../../src/serialise/store";

const ACTOR = "fixture";
const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

const { db, close } = await createInMemoryDb();
const { id: ownerId } = await ensureUser(db, LOCAL_IDENTITY);

const other = await createProject(db, { key: "other", name: "The other half", type: "software", ownerId }, ACTOR);
await createItem(db, { projectId: other.id, area: "OPS", title: "Host the server" }, ACTOR);
await createItem(db, { projectId: other.id, area: "OPS", title: "Sign people in" }, ACTOR);

const demo = await createProject(db, { key: "demo", name: "Demo plan", type: "software", ownerId }, ACTOR);
const item = (input: { area?: string; parent?: string; title: string; body?: string; deps?: string[] }) =>
  createItem(db, { projectId: demo.id, ...input }, ACTOR);

await item({ area: "PLAT", title: "Scaffold the repo", body: "A TypeScript project with vite, vitest and one `verify`." });
await item({ area: "PLAT", title: "Run CI on every pull request" });
await item({
  area: "DATA",
  title: "Storage foundation",
  body: "Drizzle ORM over PGlite locally and server Postgres in the cloud, behind one small interface.",
  deps: ["PLAT-1"],
});
await item({ area: "DATA", title: "Migrations" });
await item({ area: "DATA", title: "The plan as YAML", body: "Deterministic export, so a change is a one-line diff.", deps: ["DATA-1", "DATA-2"] });
await item({ area: "DATA", title: "Full-text search", deps: ["DATA-1"] });
await item({ area: "DATA", title: "Round-trip the plan", body: "Export, import and export again, byte for byte.", deps: ["DATA-3"] });
await item({ area: "DATA", title: "A ticket that was withdrawn" });
await item({ area: "VIEW", title: "The graph viewer", body: "A parent: its children are drawn inside its box." });
await item({ parent: "VIEW-1", title: "Lay out the graph", deps: ["DATA-3"] });
await item({ parent: "VIEW-1", title: "Show an item's prose" });
await item({ area: "MCP", title: "Serve the tools over stdio", deps: ["DATA-1", "other:OPS-1", "other:OPS-2"] });

await setStatus(db, { projectId: demo.id, ref: "PLAT-1", status: "done" }, ACTOR);
await setStatus(db, { projectId: demo.id, ref: "DATA-1", status: "done" }, ACTOR);
await setStatus(db, { projectId: demo.id, ref: "DATA-3", status: "in-progress" }, ACTOR);
await setStatus(db, { projectId: demo.id, ref: "VIEW-1.1", status: "review" }, ACTOR);
// Soft-deleted, so it stays in the file (it is the durable copy) and must never be counted by the viewer.
await deleteItem(db, { projectId: demo.id, ref: "DATA-6" }, ACTOR);

await saveStore(db, here("demo.apm.yaml"), new Set([demo.id]));
await saveStore(db, here("other.apm.yaml"), new Set([other.id]));
await close();
console.log("wrote e2e/fixture/demo.apm.yaml and e2e/fixture/other.apm.yaml");
