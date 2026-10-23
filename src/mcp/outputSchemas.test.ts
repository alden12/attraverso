/**
 * Every tool that declares an output schema, called through a real MCP server and client (`MCP-30`).
 *
 * `tools.test.ts` calls handlers through a stub `registerTool`, which is quick and tests what each reply says,
 * but skips the one check the SDK makes on the way out: **a tool with an `outputSchema` must send structured
 * content that fits it on every successful reply, or the reply becomes an error.** That is how `search_plan`
 * answered every miss with an error for a release while its "a miss is not an error" test passed. So these go
 * through `McpServer` and `Client` over the SDK's in-memory transport, which runs the real validation.
 *
 * Each call is on an empty project, because the empty branch is the one written separately and so the one
 * that forgets the structured half.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { freshDb } from "../db/testing";
import { createProjectWithDefaults } from "../domain/projects";
import { registerTools } from "./tools";

/**
 * The arguments that reach each schema'd tool's empty answer. Listed by hand, and checked against the server's
 * own list below, so a tool that gains a schema without a case here fails rather than going unchecked.
 */
const EMPTY_CALLS: Record<string, Record<string, unknown>> = {
  list_projects: {},
  list_areas: { project: "empty" },
  list_items: { project: "empty" },
  list_metrics: { project: "empty" },
  list_comments: { project: "empty" },
  // A word no text contains, not a sentence: a search with no full match widens to any of its words, and a
  // new project's stock protocol holds plenty of ordinary ones.
  search_plan: { project: "empty", query: "zzqxv" },
};

describe("tools with an output schema, over a real client (MCP-30)", () => {
  let client: Client;
  let schemaTools: string[];

  beforeAll(async () => {
    const { db, ownerId } = await freshDb();
    await createProjectWithDefaults(db, { key: "empty", name: "Empty", type: "software", ownerId }, "test");
    const server = new McpServer({ name: "test", version: "0" });
    registerTools(
      server,
      db,
      { persist: async () => {}, refresh: async () => false, appendMeasurements: async () => {} },
      { open: async (key: string) => `http://127.0.0.1:5177/#${key}`, close: async () => {} },
      { ownerId },
    );
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    schemaTools = (await client.listTools()).tools.filter((tool) => tool.outputSchema !== undefined).map((tool) => tool.name);
  });

  it("has an empty-answer case for every tool that declares a schema", () => {
    expect(schemaTools.length).toBeGreaterThan(0);
    expect(schemaTools.filter((name) => !(name in EMPTY_CALLS))).toEqual([]);
  });

  for (const [name, args] of Object.entries(EMPTY_CALLS)) {
    it(`${name} answers an empty result as a result, not an error`, async () => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
      expect(result.structuredContent).toBeDefined();
    });
  }
});
