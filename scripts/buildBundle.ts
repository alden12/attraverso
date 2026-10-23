/**
 * The `.mcpb` bundle (OPS-8): the standalone build (OPS-7) plus a `manifest.json`, zipped, so Claude Desktop
 * installs it from Settings -> Extensions -> Advanced settings -> Install Extension with nothing else to do.
 * No `claude_desktop_config.json` to edit, and no Node to install - Desktop ships its own (v24 as tested).
 *
 * Two things here are not obvious and cost a cycle each during the OPS-8 spike:
 *
 * - **`manifest_version` must name the newest schema the CLI ships.** `mcpb validate` validates against
 *   whichever version the manifest *declares*, so a manifest claiming an old version passes validation and is
 *   then silently ignored on install, with no error anywhere. Validation is a syntax check, never a
 *   compatibility one.
 * - **`user_config` is the only way the store path is visible to the user.** Claude Desktop is started by
 *   launchd at `cwd: /`, so the tree-walk that finds a repo's `attraverso.yaml` cannot work and the home-dir
 *   fallback always applies. Without this field a user silently gets `~/.ai-project-manager/attraverso.yaml`
 *   with no indication a choice existed.
 */
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const standalone = join(repoRoot, "standalone");

/** Pinned so a CLI upgrade cannot silently change the manifest schema under us; bump deliberately. */
const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const MANIFEST_VERSION = "0.4";

interface PackageJson {
  version: string;
  description?: string;
}

async function main(): Promise<void> {
  if (!existsSync(join(standalone, "server.js"))) {
    throw new Error("no standalone build - run `yarn build:standalone` first");
  }
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as PackageJson;

  const manifest = {
    manifest_version: MANIFEST_VERSION,
    name: "attraverso",
    display_name: "Attraverso",
    version: pkg.version,
    description: "Durable, structured project memory that Claude reads and writes: the plan, what happened, and the facts learned along the way.",
    author: { name: "Alden Laslett", url: "https://github.com/alden12/attraverso" },
    server: {
      type: "node",
      entry_point: "server.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server.js"],
        // Passed through from user_config below. Empty means unset, and the server falls back to the home dir.
        env: { APM_STORE_PATH: "${user_config.store_path}" },
      },
    },
    user_config: {
      store_path: {
        type: "file",
        title: "Plan file",
        description:
          "Where this project's plan is kept, as a committed `attraverso.yaml` in a repo or a file in your home directory. " +
          "Leave blank to use ~/.ai-project-manager/attraverso.yaml, which is created on first run. One file can hold several projects.",
        required: false,
      },
    },
    tools: TOOLS,
    compatibility: { platforms: ["darwin", "win32"] },
  };

  await writeFile(join(standalone, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // Validate then pack, both through the pinned CLI. Validation is cheap and catches a malformed manifest
  // before the much slower zip; it does not catch the version trap above, hence the constant.
  for (const args of [["validate", "manifest.json"], ["pack", ".", join(repoRoot, "dist", "ai-project-manager.mcpb")]]) {
    const result = spawnSync("npx", ["--yes", MCPB_CLI, ...args], { cwd: standalone, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`mcpb ${args[0]} failed`);
  }
}

/** Declared for the install dialog, which lists them so a user can see what they are granting before they
 *  agree. Kept in sync by hand: the manifest is metadata, and the server still registers its own tools. */
const TOOLS = [
  { name: "get_project", description: "Read a project at a glance: direction, protocol, open items and section headings." },
  { name: "create_project", description: "Create a project." },
  { name: "list_projects", description: "List all projects." },
  { name: "set_direction", description: "Set or revise a project's running direction." },
  { name: "create_item", description: "Create an item." },
  { name: "list_items", description: "List items, optionally filtered." },
  { name: "get_item", description: "Read one item in full, with its comments." },
  { name: "edit_item", description: "Revise an item's title or body." },
  { name: "set_status", description: "Change an item's status." },
  { name: "add_comment", description: "Add a short remark to an item as work happens." },
  { name: "list_comments", description: "Read comments back, newest first." },
  { name: "edit_comment", description: "Revise a comment." },
  { name: "delete_comment", description: "Remove a comment." },
  { name: "list_context", description: "List the project's context sections." },
  { name: "get_context", description: "Read one context section." },
  { name: "set_context", description: "Write or revise a context section." },
  { name: "delete_context", description: "Remove a context section." },
  { name: "open_viewer", description: "Start the roadmap graph viewer and return a URL that opens on a project's graph." },
];

main().catch((error: unknown) => {
  process.stderr.write(`build:bundle failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
