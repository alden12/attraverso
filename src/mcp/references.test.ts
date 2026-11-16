/**
 * Source references through the tools (`CTX-13`, slice 4): what a writer sends and what a reader is given.
 *
 * Handlers are captured through a stub `McpServer`, as in `tools.test.ts`, so these exercise the real tool code and
 * the real domain over a fresh database, with no transport in between.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { freshDb } from "../db/testing";
import type { Database } from "../db/client";
import { getItem } from "../domain/items";
import { createProjectWithDefaults } from "../domain/projects";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { events, sourceReferences } from "../db/schema";
import { registerTools } from "./tools";

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

/** Each tool's input schema, as the SDK validates a call against it before the handler runs. */
const schemas = new Map<string, z.ZodRawShape>();

function toolsOf(db: Database, ownerId: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const stub = {
    registerTool: (name: string, config: { inputSchema?: z.ZodRawShape }, handler: Handler) => {
      schemas.set(name, config.inputSchema ?? {});
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerTools(
    stub,
    db,
    { persist: async () => {}, refresh: async () => false, appendMeasurements: async () => {} },
    { open: async (key: string) => `http://127.0.0.1:5177/#${key}`, close: async () => {} },
    { ownerId },
  );
  return handlers;
}

const said = (result: CallToolResult): string => {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
};

const DAY = /\d{4}-\d{2}-\d{2}/.source;

describe("source references through the tools (CTX-13)", () => {
  let tools: Map<string, Handler>;
  let db: Database;
  let projectId: string;
  const call = async (name: string, args: Record<string, unknown>) => tools.get(name)!({ project: "apm", ...args });

  beforeEach(async () => {
    const fresh = await freshDb();
    db = fresh.db;
    projectId = (await createProjectWithDefaults(db, { key: "apm", name: "AI PM", type: "software", ownerId: fresh.ownerId }, "test")).id;
    tools = toolsOf(db, fresh.ownerId);
    await call("create_item", {
      area: "OPS",
      title: "hosting",
      body: "Postgres 18.4 runs in production [ref pg18]. We host on a VM [ref vm1].",
      sources: {
        pg18: { source: "test", detail: "yarn cloud:check" },
        vm1: { source: "user", detail: "let's stay on the VM" },
      },
    });
  });

  it("shows each claim's sources beside it when the item is read", async () => {
    const body = said(await call("get_item", { ref: "OPS-1" }));
    expect(body).toMatch(new RegExp(`Postgres 18\\.4 runs in production \\[ref pg18: test ${DAY} yarn cloud:check\\]`));
    expect(body).toMatch(new RegExp(`We host on a VM \\[ref vm1: user ${DAY} "let's stay on the VM"\\]`));
  });

  it("always shows a code location, and the user's words up to a length, cut at a word (CTX-16)", async () => {
    const code = "packages/core/src/domain/references.ts:160-200@250c0d6";
    const quote = "Can we also add a ticket to drag and drop items between statuses in the board view, and keep the agreed order while we are at it?";
    await call("edit_item", { ref: "OPS-1", sources: { pg18: { source: "code", detail: code }, vm1: { source: "user", detail: quote } } });
    const read = said(await call("get_item", { ref: "OPS-1" }));
    expect(read).toContain(code);
    expect(read).toContain('"Can we also add a ticket to drag and drop items between statuses in the board view, and keep the..."');
    expect(read).not.toContain("agreed order");
    expect(said(await call("get_item", { ref: "OPS-1", references: "full" }))).toContain(`"${quote}"`);
  });

  it("leaves a long detail out unless asked for in full", async () => {
    const url = "https://example.com/a/very/long/path/to/the/release/notes/page";
    await call("edit_item", { ref: "OPS-1", sources: { pg18: { source: "search", detail: url } } });
    expect(said(await call("get_item", { ref: "OPS-1" }))).not.toContain(url);
    expect(said(await call("get_item", { ref: "OPS-1", references: "full" }))).toContain(url);
  });

  it("reports a sourced claim an edit changed, and flags it on the next read", async () => {
    const reply = said(await call("edit_item", { ref: "OPS-1", body: "Postgres 18.6 runs in production [ref pg18]. We host on a VM [ref vm1]." }));
    expect(reply).toContain('pg18 (test');
    expect(reply).toContain('"Postgres 18.4 runs in production" -> "Postgres 18.6 runs in production"');
    expect(said(await call("get_item", { ref: "OPS-1" }))).toMatch(/\[ref pg18: test [^\]]*, text changed since\]/);
  });

  it("stores the bare pointer when a body read with expanded pointers is sent straight back", async () => {
    const read = said(await call("get_item", { ref: "OPS-1" }));
    const body = read.slice(read.indexOf("Postgres 18.4"), read.indexOf("[ref vm1") + read.slice(read.indexOf("[ref vm1")).indexOf("]") + 2);
    const reply = said(await call("edit_item", { ref: "OPS-1", body }));
    expect(reply).not.toContain("sourced claims you changed");
    expect((await getItem(db, projectId as never, "OPS-1"))!.body).toBe("Postgres 18.4 runs in production [ref pg18]. We host on a VM [ref vm1].");
  });

  it("retires a reference whose pointer an edit removed, and says so", async () => {
    const reply = said(await call("edit_item", { ref: "OPS-1", body: "Postgres 18.4 runs in production [ref pg18]. We host on a VM." }));
    expect(reply).toContain("vm1 (user");
    expect(reply).toContain("pointer removed, so its sources were retired");
    expect(said(await call("get_item", { ref: "OPS-1" }))).not.toContain("vm1");
  });

  it("refuses a source whose pointer is not in the text, saying where to put it", async () => {
    const result = await call("edit_item", { ref: "OPS-1", sources: { nope: { source: "docs", detail: "README.md" } } });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain("no [ref nope] in the text: write it straight after the claim it stands behind");
  });

  it("says a pointer is written but not read, rather than missing, when it is in code (CTX-17.3)", async () => {
    const result = await call("edit_item", { ref: "OPS-1", body: "Run `[ref c1]` here.", sources: { c1: { source: "docs", detail: "README.md" } } });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain("[ref c1] is in the text but is not read as a pointer");
  });

  it("refuses sources for a key written twice, rather than binding them to the last claim (CTX-17.1)", async () => {
    const body = "The guide covers setup [ref dup]. It also covers troubleshooting [ref dup].";
    const result = await call("edit_item", { ref: "OPS-1", body, sources: { dup: { source: "docs", detail: "README.md" } } });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain("[ref dup] appears more than once: a key stands behind one claim");
    expect((await getItem(db, projectId as never, "OPS-1"))!.body).not.toContain("dup");
  });

  it("says a pointer moved, rather than that its claim was rewritten, when the old claim is still there (CTX-17.4)", async () => {
    const reply = said(await call("edit_item", { ref: "OPS-1", body: "Postgres 18.4 runs in production.\n\nWe host on a VM [ref pg18]." }));
    expect(reply).toContain('pg18 (test');
    expect(reply).toContain('the pointer now sits on a different claim, "We host on a VM"');
    expect(reply).not.toContain('"Postgres 18.4 runs in production" -> ');
  });

  describe("one source behind many claims, re-checked and cleared (CTX-17.2, CTX-17.5)", () => {
    const rows = () => db.select().from(sourceReferences).orderBy(sourceReferences.recordedAt);

    it("replaces a key's citation when the same source is given again, rather than piling up", async () => {
      await call("edit_item", { ref: "OPS-1", body: "Postgres 18.6 runs in production [ref pg18]. We host on a VM [ref vm1]." });
      const reply = said(await call("edit_item", { ref: "OPS-1", sources: { pg18: { source: "test", detail: "yarn cloud:check" } } }));
      expect(reply).toContain("sources re-checked (the claim's current text and today's date replace the old): pg18");
      const pg18 = (await rows()).filter((r) => r.key === "pg18");
      // The old citation is retired, not deleted, and the new one records the claim as it reads now.
      expect(pg18.map((r) => [r.quotedText, r.retiredAt !== null])).toEqual([
        ["Postgres 18.4 runs in production", true],
        ["Postgres 18.6 runs in production", false],
      ]);
      const read = said(await call("get_item", { ref: "OPS-1" }));
      expect(read).toMatch(new RegExp(`\\[ref pg18: test ${DAY} yarn cloud:check\\]`));
    });

    it("adds a different source beside the one a key has", async () => {
      await call("edit_item", { ref: "OPS-1", sources: { pg18: { source: "docs", detail: "README.md" } } });
      expect((await rows()).filter((r) => r.key === "pg18" && r.retiredAt === null)).toHaveLength(2);
    });

    it("clears a key's sources with null, and refuses to clear a key with none", async () => {
      const reply = said(await call("edit_item", { ref: "OPS-1", sources: { vm1: null } }));
      expect(reply).toContain("sources cleared from: vm1");
      expect(said(await call("get_item", { ref: "OPS-1" }))).toContain("[ref vm1: no reference behind it]");
      const again = await call("edit_item", { ref: "OPS-1", sources: { vm1: null } });
      expect(again.isError).toBe(true);
      expect(said(again)).toContain("[ref vm1] has no sources here to clear");
    });

    it("says a source was reused, and shows a claim when its source was cited again since", async () => {
      // The first citation of the guide is old; citing it for another claim today says the guide was read again.
      await call("edit_item", { ref: "OPS-1", sources: { pg18: { source: "docs", detail: "https://example.com/guide" } } });
      await db.update(sourceReferences).set({ recordedAt: "2026-01-01T00:00:00.000Z" }).where(eq(sourceReferences.detail, "https://example.com/guide"));
      const reply = said(
        await call("create_item", { area: "OPS", title: "setup", body: "The guide covers setup [ref setup1].", sources: { setup1: { source: "docs", detail: "https://example.com/guide" } } }),
      );
      expect(reply).toContain("reused sources: setup1 (docs, also behind 1 other claim)");
      const today = new Date().toISOString().slice(0, 10);
      expect(said(await call("get_item", { ref: "OPS-1" }))).toContain(`docs 2026-01-01 https://example.com/guide (source rechecked ${today})`);
      expect(said(await call("get_item", { ref: "OPS-2" }))).not.toContain("source rechecked");
    });
  });

  it("refuses a key that already stands behind a claim in another item", async () => {
    const result = await call("create_item", { area: "OPS", title: "other", body: "Also 18.4 [ref pg18].", sources: { pg18: { source: "docs", detail: "x" } } });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain("reference pg18 already stands behind a claim elsewhere");
  });

  it("refuses a source kind that is not one, naming the ones that are", async () => {
    const result = await call("edit_item", { ref: "OPS-1", sources: { pg18: { source: "agent", detail: "I think so" } } });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain("use one of user, test, search, docs");
  });

  it("takes a code source pinned to a commit, and refuses one that is not", async () => {
    const ok = await call("edit_item", { ref: "OPS-1", sources: { pg18: { source: "code", detail: "src/db/schema.ts:120-140@345a746" } } });
    expect(ok.isError).toBeFalsy();
    expect(said(await call("get_item", { ref: "OPS-1" }))).toContain("code ");
    const bad = await call("edit_item", { ref: "OPS-1", sources: { pg18: { source: "code", detail: "src/db/schema.ts" } } });
    expect(bad.isError).toBe(true);
    expect(said(bad)).toContain("write path:line or path:from-to, optionally :column, then @commit");
  });

  it("does the same for context sections", async () => {
    await call("set_context", { heading: "Hosting", content: "One region only [ref reg1].", sources: { reg1: { source: "docs", detail: "infra/region.tf" } } });
    expect(said(await call("get_context", { heading: "Hosting" }))).toMatch(new RegExp(`One region only \\[ref reg1: docs ${DAY} infra/region\\.tf\\]`));
    const reply = said(await call("set_context", { heading: "Hosting", content: "Two regions [ref reg1]." }));
    expect(reply).toContain('"One region only" -> "Two regions"');
  });

  it("round-trips a body whose sources hold brackets, backticks and line breaks", async () => {
    await call("create_item", {
      area: "OPS",
      title: "awkward",
      body: "A claim here [ref h1]. Then `code` and another [ref h2].",
      sources: {
        h1: [
          { source: "user", detail: "run `x` and see\nwhat [it] says" },
          { source: "test", detail: "[ -f x ]" },
        ],
        h2: { source: "docs", detail: "app/[id]/page.tsx" },
      },
    });
    for (const references of [undefined, "full"]) {
      const read = said(await call("get_item", { ref: "OPS-2", references }));
      const body = read.split("\n").find((line) => line.startsWith("A claim here"))!;
      expect(said(await call("edit_item", { ref: "OPS-2", body }))).not.toContain("sourced claims you changed");
      expect((await getItem(db, projectId as never, "OPS-2"))!.body).toBe("A claim here [ref h1]. Then `code` and another [ref h2].");
    }
  });

  it("clears \"text changed since\" once a source is added for the new wording", async () => {
    await call("edit_item", { ref: "OPS-1", body: "Postgres 18.6 runs in production [ref pg18]. We host on a VM [ref vm1]." });
    expect(said(await call("get_item", { ref: "OPS-1" }))).toMatch(/\[ref pg18: [^\]]*text changed since\]/);
    await call("edit_item", { ref: "OPS-1", sources: { pg18: { source: "test", detail: "yarn cloud:check" } } });
    expect(said(await call("get_item", { ref: "OPS-1" }))).not.toContain("text changed since");
  });

  it("checks keys and empty sources before a write is attempted", async () => {
    const valid = (sources: unknown) => z.object(schemas.get("edit_item")!).safeParse({ project: "apm", ref: "OPS-1", sources }).success;
    expect(valid({ pg18: { source: "test", detail: "x" } })).toBe(true);
    expect(valid({ PG18: { source: "test", detail: "x" } })).toBe(false);
    expect(valid({ pg18: [] })).toBe(false);
    expect(valid({})).toBe(false);
    expect(valid({ pg18: { source: "test", detail: "" } })).toBe(false);
    expect(valid({ pg18: { source: "test", detail: "x".repeat(501) } })).toBe(false);
    expect(valid(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, { source: "test", detail: "x" }])))).toBe(false);
  });

  it("records the sources it added in the event log", async () => {
    const created = await db.select({ after: events.after }).from(events).where(eq(events.kind, "created"));
    const payloads = created.map((row) => JSON.parse(row.after ?? "{}") as { addedSources?: { key: string }[] });
    expect(payloads.flatMap((p) => p.addedSources ?? []).map((a) => a.key)).toEqual(["pg18", "vm1"]);
    await call("edit_item", { ref: "OPS-1", sources: { pg18: { source: "docs", detail: "README.md" } } });
    const edited = await db.select({ after: events.after }).from(events).where(eq(events.kind, "edited"));
    expect(JSON.parse(edited.at(-1)!.after!).addedSources).toEqual([{ key: "pg18", source: "docs", detail: "README.md" }]);
  });

  it("tells the writer about a malformed pointer in the same reply", async () => {
    const reply = said(await call("edit_item", { ref: "OPS-1", body: "Postgres 18.4 runs in production [ref pg18]. We host on a VM [ref vm1]. See [ref CTX-13]." }));
    expect(reply).toContain("pointer problems");
    expect(reply).toContain("where a key is lowercase letters and digits");
  });
});
