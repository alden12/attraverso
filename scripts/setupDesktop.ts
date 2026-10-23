/**
 * `yarn setup:desktop` - register this MCP server in Claude Desktop's config with the machine-specific
 * absolute paths filled in automatically, then verify the launch command keeps stdout clean.
 *
 * Idempotent: re-running updates the entry. The existing config is backed up (`.bak`) and its other keys are
 * preserved. The paths are derived here rather than hand-typed: `process.execPath` is the absolute node that
 * ran this script (the one Claude Desktop should use, since launchd gives the app no PATH), and the repo and
 * server paths come from this file's location. See docs/claude-desktop.md for what each part works around.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * `-dev` because this runs the server from a checkout, and Desktop may also have the published package under
 * plain `attraverso` (docs/claude-desktop.md). One key each, so setting up a checkout never overwrites it.
 */
const SERVER_NAME = "attraverso-dev";
/** What this script registered as before the rename (`DIST-5`), removed so Desktop does not run both. */
const LEGACY_NAMES = ["ai-project-manager"];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodePath = process.execPath;
// Found by resolution, not by path: hoisted to the workspace root's `node_modules` in development, beside this
// package in a checkout of the public repo.
const viteNode = join(dirname(createRequire(import.meta.url).resolve("vite-node/package.json")), "vite-node.mjs");
const serverEntry = join(repoRoot, "src", "mcp", "server.ts");
const launchArgs = [viteNode, "--root", repoRoot, serverEntry];

function configPath(): string {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(home, ".config", "Claude", "claude_desktop_config.json"); // best-effort for other platforms
}

function writeConfig(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak`); // never overwrite the user's config without a backup
    try {
      config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      console.error(`Existing config at ${path} is not valid JSON. Fix or remove it and re-run; leaving it untouched.`);
      process.exit(1);
    }
  }
  const servers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
  for (const legacy of LEGACY_NAMES) delete servers[legacy];
  servers[SERVER_NAME] = { command: nodePath, args: launchArgs };
  config.mcpServers = servers;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Spawn the exact configured launch command (from a foreign cwd, as launchd does) and confirm nothing
 * reaches stdout. This catches the classic stdio-server failure - a dependency printing a banner - before it
 * shows up as an "not valid JSON" warning in Claude Desktop.
 */
function verifyStdoutClean(): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolveP) => {
    const child = spawn(nodePath, launchArgs, { stdio: ["ignore", "pipe", "pipe"], cwd: "/" });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolveP({ ok: stdout.length === 0, stdout });
    };
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("ready on stdio")) finish(); // booted; sample stdout now
    });
    child.on("error", () => finish());
    const timer = setTimeout(finish, 20000);
  });
}

async function main(): Promise<void> {
  if (!existsSync(viteNode)) {
    console.error(`vite-node not found at ${viteNode}. Run "yarn install" first.`);
    process.exit(1);
  }
  const path = configPath();
  writeConfig(path);
  console.log(`Registered "${SERVER_NAME}" in ${path}`);
  console.log(`  command: ${nodePath}`);
  console.log(`  args:    ${launchArgs.join(" ")}`);

  if (process.argv.includes("--no-verify")) {
    console.log("\nSkipped launch verification (--no-verify). Fully quit and reopen Claude Desktop.");
    return;
  }
  process.stdout.write("\nVerifying the launch command keeps stdout clean ... ");
  const { ok, stdout } = await verifyStdoutClean();
  if (ok) {
    console.log("clean.\n\nDone. Fully quit and reopen Claude Desktop.");
  } else {
    console.log("POLLUTED.");
    console.error(`\nThe server wrote ${stdout.length} bytes to stdout, which will corrupt the MCP stream:`);
    console.error(`  ${stdout.slice(0, 200).replace(/\n/g, "\\n")}`);
    console.error("\nThe config was written, but fix the stdout output above before using it.");
    process.exit(1);
  }
}

void main();
