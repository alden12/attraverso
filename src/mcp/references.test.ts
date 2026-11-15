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
import { registerTools } from "./tools";

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function toolsOf(db: Database, ownerId: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const stub = { registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler) } as unknown as McpServer;
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

  it("does the same for context sections", async () => {
    await call("set_context", { heading: "Hosting", content: "One region only [ref reg1].", sources: { reg1: { source: "docs", detail: "infra/region.tf" } } });
    expect(said(await call("get_context", { heading: "Hosting" }))).toMatch(new RegExp(`One region only \\[ref reg1: docs ${DAY} infra/region\\.tf\\]`));
    const reply = said(await call("set_context", { heading: "Hosting", content: "Two regions [ref reg1]." }));
    expect(reply).toContain('"One region only" -> "Two regions"');
  });
});
