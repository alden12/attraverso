/**
 * The stdio MCP server (MCP-1): what Claude Desktop launches and talks to. It boots one in-memory database
 * for the process, registers the tools, and connects a stdio transport.
 *
 * The cardinal rule of a stdio server: **nothing may be written to stdout except protocol frames**, or the
 * JSON-RPC stream corrupts and the server "works then mysteriously breaks". So all logging goes to stderr,
 * and the SDK owns stdout. (PGlite's boot is stdout-clean, verified in the DATA-14 spike.)
 */
import "../env"; // load a dev .env (e.g. APM_STORE_PATH) before anything reads it; quiet, writes to neither stream
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../../package.json" with { type: "json" };
import { ensureUser, LOCAL_IDENTITY } from "../domain/users";
import { databaseBacked, fileBacked } from "./runtime";
import { INSTRUCTIONS, registerTools } from "./tools";
import { createViewerHost } from "./viewer";

async function main(): Promise<void> {
  const url = process.env.APM_DATABASE_URL;
  const { db, access, sources, describe } = url === undefined || url === "" ? await fileBacked() : await databaseBacked(url);

  // Version from package.json rather than a literal: the bundle manifest already reads it from there
  // (buildBundle.ts), and two copies of a version number drift the moment one of them is bumped.
  const server = new McpServer({ name: pkg.name, version: pkg.version }, { instructions: INSTRUCTIONS });

  // stdio has no credential to present and never will: it is launched by Claude Desktop as one person, on one
  // machine, over a pipe. So it acts as the single local account (`OPS-4`) rather than acquiring a "no caller"
  // path of its own - which would be an unscoped code path, and therefore the untested one.
  //
  // With `APM_DATABASE_URL` set this same local account is used against a real Postgres, which is deliberate:
  // an unauthenticated process gets its *own* account there, not everyone's projects. Pointed at the deployed
  // database it will look empty, and that is the correct answer rather than a bug.
  const caller = { ownerId: (await ensureUser(db, LOCAL_IDENTITY)).id };

  // Constructed here but not bound: the viewer only takes a port when `open_viewer` is first called (VIEW-12).
  registerTools(server, db, access, createViewerHost(db, sources, access, caller), caller);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`${pkg.name} MCP server ready on stdio (${describe})\n`);
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
