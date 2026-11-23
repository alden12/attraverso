/**
 * Optional packages the loopback viewer host serves beside the plan, when they are installed next to attraverso.
 *
 * Nothing here depends on them: each is tried by name at startup, by a dynamic import of a string, so the build and
 * the type check never see it, and a package that isn't installed is simply absent. One that is gives a path prefix,
 * a label for the viewer's tab, and a web-standard handler (`Request` in, a `Response` or undefined out), which the
 * host runs for every request under that prefix before its own routes.
 *
 * Nothing here writes to stdout: this runs inside the stdio MCP process, where stdout is the protocol.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/** What an extension package exports as `viewerExtension`, made for the plans the host serves. */
export interface ViewerExtension {
  /** The path it answers under, `/name`, with no trailing slash. */
  prefix: string;
  /** Its tab's label in the viewer. */
  label: string;
  /** A path under its prefix answering `{ count: number }`, drawn on its tab (how many things wait there), if any. */
  count?: string;
  handle(request: Request): Promise<Response | undefined>;
}

type Factory = (options: { plans: string[] }) => ViewerExtension;

/** The packages tried, by the module each exports its extension from. */
export const OPTIONAL_EXTENSIONS = ["@attraverso/pr-reviewer/host"];

/** Whether `error` says the package itself isn't installed, rather than that it is and is broken. */
const isMissing = (error: unknown, specifier: string): boolean => {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : String(error);
  const name = specifier.split("/").slice(0, 2).join("/");
  return (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") && message.includes(name);
};

/**
 * The extensions installed here, each made for `plans` (the plan files the host serves, primary first). One that is
 * installed but fails to load is reported on stderr and left out, rather than taking the viewer down with it.
 */
export async function loadExtensions(plans: string[], specifiers = OPTIONAL_EXTENSIONS): Promise<ViewerExtension[]> {
  const loaded = await Promise.all(
    specifiers.map(async (specifier) => {
      try {
        const module = (await import(/* @vite-ignore */ specifier)) as { viewerExtension?: Factory };
        if (typeof module.viewerExtension !== "function") throw new Error("it exports no viewerExtension");
        return [module.viewerExtension({ plans })];
      } catch (error) {
        if (!isMissing(error, specifier)) {
          process.stderr.write(`viewer: ${specifier} is installed but did not load: ${String(error)}\n`);
        }
        return [];
      }
    }),
  );
  return loaded.flat();
}

/** The extension a path belongs to, if any. */
export const extensionFor = (extensions: ViewerExtension[], path: string): ViewerExtension | undefined =>
  extensions.find((extension) => path === extension.prefix || path.startsWith(`${extension.prefix}/`));

/**
 * A node request as a fetch `Request`. Its body is the node stream, read whole by whoever reads it: only requests
 * under an extension's prefix come here, and the extension answers all of them, so nothing is passed on after.
 */
const toRequest = (request: IncomingMessage, origin: string): Request => {
  const method = request.method ?? "GET";
  const headers = new Headers(
    Object.entries(request.headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value] as [string, string]],
    ),
  );
  const body = method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(request), duplex: "half" };
  return new Request(new URL(request.url ?? "/", origin), { method, headers, ...body } as RequestInit);
};

/** Runs `extension` for a node request and writes its answer, never cached; false when it answered nothing. */
export async function serveExtension(
  extension: ViewerExtension,
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
): Promise<boolean> {
  const answer = await extension.handle(toRequest(request, origin));
  if (answer === undefined) return false;
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  answer.headers.forEach((value, name) => {
    headers[name] = value;
  });
  response.writeHead(answer.status, headers);
  response.end(answer.body ? Buffer.from(await answer.arrayBuffer()) : undefined);
  return true;
}
