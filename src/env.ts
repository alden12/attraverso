/**
 * Load a local `.env` into `process.env`, for developer convenience only. Importing this for its side
 * effect (`import "../src/env"`) at an entry point is what makes a gitignored `.env` take effect (e.g.
 * `APM_STORE_PATH`, which points at the project's YAML file), since vite-node does not load `.env` on its own
 * the way some frameworks do.
 *
 * The path is resolved relative to this file, not the working directory, because the CLI and the server can
 * be launched from anywhere and must still find the repo's `.env`. A missing file is not an error: in
 * production the environment is provided directly (the Claude Desktop config's `env` block), and there is no
 * `.env` at all.
 *
 * Never import this from library code or tests. Tests build a fresh in-memory database directly (`freshDb`)
 * and read no environment, so they are never affected by a developer's `.env`; keeping the load at the entry
 * points preserves that.
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// `quiet: true` is not optional here: dotenv v17 prints an "injecting env ... // tip:" banner to STDOUT by
// default, which corrupts the MCP stdio stream (Claude Desktop reports "not valid JSON"). A stdio server
// must keep stdout to protocol frames only.
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), quiet: true });
