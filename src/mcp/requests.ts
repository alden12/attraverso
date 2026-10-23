/**
 * Reading a request body, shared by the loopback viewer host and the hosted server (`VIEW-24`).
 *
 * Its own module so the hosted bundle does not import `viewer.ts` to reuse three helpers - that file carries
 * the whole loopback host, including a file-backed media store which is dead weight in a cloud image.
 */
import { z } from "zod";
import type { IncomingMessage } from "node:http";
import { MAX_BYTES } from "../media/store";
import { STATUS_VALUES } from "../../scripts/tickets";

/**
 * What `POST /api/ticket` accepts (VIEW-17). One field today; `VIEW-19` adds `title`, `body` and the
 * `expectedUpdatedAt` that `VIEW-18` compares against, all as optional fields with a rule that at least one
 * is present - which is the point at which this being a schema rather than a chain of `if`s stops being
 * merely tidier.
 *
 * The enum message is overridden because zod's default ("Invalid enum value. Expected 'done' | ...") is
 * phrased for a developer reading a stack trace, and this string is shown to whoever is using the viewer.
 */
export const ticketChange = z.object({
  status: z.enum(STATUS_VALUES, { errorMap: () => ({ message: `must be one of: ${STATUS_VALUES.join(", ")}` }) }),
});

/**
 * Validate a JSON request body against a zod schema, the way the MCP boundary validates a tool call.
 *
 * This boundary was hand-checking its one field, which was survivable at one field and stops being so at
 * `VIEW-19`'s three-plus-a-version with an at-least-one-present rule. It is the same job the tool layer
 * already gives zod, and the same reason: a schema is checkable, composable and cannot drift from the type
 * the handler goes on to use.
 *
 * Two things it fixes beyond tidiness. Malformed JSON used to reach the caller as `JSON.parse`'s own message
 * ("Unexpected token } in JSON at position 5"), which is an internal detail phrased for nobody. And the
 * failure is now reported per field with the field named, so a request wrong in two ways says so at once
 * rather than one round trip at a time.
 */
export async function parseBody<T>(request: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const raw = Buffer.from(await readBody(request)).toString("utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("the request body is not valid JSON");
  }
  const result = schema.safeParse(json);
  if (result.success) return result.data;
  throw new Error(result.error.issues.map((issue) => `${issue.path.join(".") || "body"} ${issue.message}`).join("; "));
}

/** Read a whole request body, refusing anything over the cap before it is buffered rather than after. */
export async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).byteLength;
    if (total > MAX_BYTES) throw new Error(`upload exceeds the ${MAX_BYTES / 1024 / 1024}MB limit`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
