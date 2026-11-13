/**
 * `attraverso viewer` (`VIEW-47`): the graph viewer from a terminal, for someone using the package without asking
 * Claude to open it (the `open_viewer` tool).
 *
 * **The same host as `open_viewer`, booted the same way.** It finds the plan as the server does (`--store`, else
 * `APM_STORE_PATH`, else the nearest `attraverso.yaml` walking up to the git root), loads it into its own
 * in-memory database through `fileBacked`, and binds `createViewerHost` - so it has the real write-through, the
 * stale-write guard (`IMP-13`) and the reload on read (`IMP-10`), and can sit beside a running MCP server on the
 * same plan exactly as two Claude windows on one store do. That is why it may write where `yarn viewer` may not
 * (`VIEW-17`): the dev server has no write-through, and this has the whole of it.
 *
 * **Stdout is fine here.** This mode never speaks JSON-RPC, so the URL is printed where a terminal user looks for
 * it, and the stdio rule (`server.ts`) does not apply.
 *
 * **It does not create a plan.** The server makes `attraverso.yaml` when it finds none, because Claude needs
 * somewhere to write; a command whose job is to show a plan should say there is nothing to show instead.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import pkg from "../../package.json" with { type: "json" };
import { listProjects } from "../domain/projects";
import { ensureUser, LOCAL_IDENTITY } from "../domain/users";
import { resolveStorePaths } from "../serialise/store";
import { fileBacked, storeArgs } from "./runtime";
import { createViewerHost } from "./viewer";

export const VIEWER_USAGE = `usage: attraverso viewer [--store <plan.yaml>]... [--project <key>] [--open]

Serves the graph viewer for the plan found here (the nearest attraverso.yaml, or --store) on 127.0.0.1, and
prints its URL. --project picks the project it opens on, --open opens it in your browser. Ctrl+C stops it.`;

/** The value after `flag` in `args`, or undefined. */
const valueOf = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

export async function runViewer(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${VIEWER_USAGE}\n`);
    return;
  }

  const missing = resolveStorePaths(storeArgs()).filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `no plan at ${missing.join(", ")}. Run this inside a project with an attraverso.yaml, or name one with --store. ` +
        "(The MCP server creates a plan the first time Claude writes to it.)",
    );
  }

  const { db, access, sources, describe } = await fileBacked();
  const caller = { ownerId: (await ensureUser(db, LOCAL_IDENTITY)).id };
  const projects = await listProjects(db, caller.ownerId);
  const wanted = valueOf(args, "--project");
  const project = wanted === undefined ? projects[0] : projects.find((candidate) => candidate.key === wanted);
  if (project === undefined) {
    throw new Error(wanted === undefined ? "the plan has no projects yet" : `no project "${wanted}"; this plan has ${projects.map((p) => p.key).join(", ")}`);
  }

  const host = createViewerHost(db, sources, access, caller);
  const url = await host.open(project.key);
  process.stdout.write(`${pkg.name} viewer: ${url}\n  ${describe}\n  Ctrl+C to stop\n`);
  if (args.includes("--open")) openInBrowser(url);

  // The bound port keeps the process alive; this only makes the exit tidy, closing the port and any open streams.
  const stop = () => void host.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** Hand the URL to the system's opener. Fire and forget: if it fails, the URL is already printed. */
function openInBrowser(url: string): void {
  const [command, ...args] =
    process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  const child = spawn(command!, args, { stdio: "ignore", detached: true });
  child.on("error", () => process.stderr.write(`could not open a browser; open ${url} yourself\n`));
  child.unref();
}
