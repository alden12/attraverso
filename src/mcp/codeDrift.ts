/**
 * Whether the code a `code` source pinned has changed since (`CTX-13`): the lines at the pinned commit against the
 * same lines of the file as it is now.
 *
 * **Only where it is cheap and possible, and only when one item or section is read** - `get_item`, `get_context`
 * and the pane opening an item; never a listing, a search or `get_project`, and at most `MAX_CODE_CHECKS` a read. The pinned lines are fetched for every
 * source in one `git cat-file --batch` process (measured 2026-11-15: about 0.25 ms a file batched, 2 ms spawning git
 * per file), so a read with a few code references pays a few milliseconds. A host with no checkout - the hosted
 * server - never calls this, and in a checkout without the pinned commit (a shallow clone: CI, a cloud session) the
 * source is simply not reported: unknown is not changed. The reference still says exactly what a claim rests on, so
 * an agent relying on it can run the `git show` itself.
 *
 * **Moved is not changed.** The pinned lines are looked for anywhere in the file now, not only at their old line
 * numbers, so an import added above them does not flag every reference below it. Only text that is no longer in the
 * file at all reads as changed, which is the signal worth having; a reference whose line numbers drifted still
 * names a commit where they were right.
 *
 * Node-only, so it lives with the server rather than beside the shared parser.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseCodeRef, type CodeRef } from "../../scripts/references";

/** Run git and take its output as bytes: `cat-file` sizes its objects in bytes, so a text decode would misalign. */
const run = (args: string[], cwd: string, input?: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 2000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
    if (input !== undefined) child.stdin?.end(input);
  });

/**
 * How many `code` sources one read checks. A read is one item or one section, so this is a body that leans on a lot
 * of code; past it the rest are not checked and so not reported, which is what an unchecked source always means
 * here - unknown, never changed. Keeps a heavily referenced body from costing a large batch and a scan of each file
 * on every read.
 */
export const MAX_CODE_CHECKS = 20;

/** Each plan file's checkout, looked up once a process: a plan file does not move between repos while it runs. */
const checkouts = new Map<string, Promise<string | null>>();

/** The checkout a plan file sits in, or null when it is not in one (or git is not there to ask). */
function checkoutOf(planPath: string): Promise<string | null> {
  let found = checkouts.get(planPath);
  if (found === undefined) {
    found = run(["rev-parse", "--show-toplevel"], dirname(planPath)).then(
      (out) => out.toString("utf8").trim() || null,
      () => null,
    );
    checkouts.set(planPath, found);
  }
  return found;
}

/**
 * `git cat-file --batch` output for `commit:path` objects, by request: the file's text, or null for each one git
 * does not have or that is not a file. Every object's bytes are stepped over whatever its type, since a `tree` or a
 * `commit` is followed by its content just as a blob is, and losing count there would file every later blob under
 * the wrong request.
 */
async function blobsAt(root: string, refs: CodeRef[]): Promise<(string | null)[]> {
  const requests = refs.map((ref) => `${ref.commit}:${ref.path}`);
  const out = await run(["cat-file", "--batch"], root, requests.join("\n") + "\n");
  const blobs: (string | null)[] = [];
  let at = 0;
  for (let i = 0; i < requests.length; i++) {
    const end = out.indexOf(10, at); // the header line
    if (end === -1) break;
    const header = out.subarray(at, end).toString();
    at = end + 1;
    const object = /^\S+ (\S+) (\d+)$/.exec(header);
    if (object === null) {
      blobs.push(null); // "<request> missing", or ambiguous: no content follows
      continue;
    }
    const size = Number(object[2]);
    blobs.push(object[1] === "blob" ? out.subarray(at, at + size).toString("utf8") : null);
    at += size + 1; // the object, then its trailing newline
  }
  return blobs;
}

/** A file's lines with trailing whitespace dropped, so a reformatted line end never reads as a change. A final
 *  newline ends the last line rather than starting an empty one. */
const linesOf = (text: string): string[] => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map((line) => line.trimEnd());

/** Lines `from` to `to` (1-based, inclusive) of the file, or null when the file is shorter. */
function pinned(all: string[], from: number, to: number): string[] | null {
  return to > all.length ? null : all.slice(from - 1, to);
}

/** Whether `lines` appear, consecutively and in order, anywhere in `file`. */
function contains(file: string[], lines: string[]): boolean {
  for (let start = 0; start + lines.length <= file.length; start++) {
    if (lines.every((line, offset) => file[start + offset] === line)) return true;
  }
  return false;
}

/**
 * The details of the `code` sources whose pinned lines are no longer in the file, in the checkout holding
 * `planFile` - the plan file that owns what is being read, so a plan spread over several repos checks each against
 * its own. Empty when there is no plan file (the hosted server passes none), no checkout or no code source; never
 * throws, since a read must not fail over an optional check.
 */
export async function codeDrift(planFile: string | undefined, sources: { source: string; detail: string }[]): Promise<Set<string>> {
  const changed = new Set<string>();
  const code = [...new Set(sources.filter((s) => s.source === "code").map((s) => s.detail))]
    .flatMap((detail) => {
      const ref = parseCodeRef(detail);
      return ref === null ? [] : [{ detail, ref }];
    })
    .slice(0, MAX_CODE_CHECKS);
  if (code.length === 0 || planFile === undefined) return changed;
  try {
    const root = await checkoutOf(planFile);
    if (root === null) return changed;
    const then = await blobsAt(
      root,
      code.map((c) => c.ref),
    );
    await Promise.all(
      code.map(async ({ detail, ref }, index) => {
        const was = then[index] === null || then[index] === undefined ? null : pinned(linesOf(then[index]!), ref.from, ref.to);
        if (was === null) return; // the commit or the file is not in this checkout, or the lines are not: unknown, not changed
        const now = await readFile(join(root, ref.path), "utf8").then(linesOf, () => null); // deleted or moved since: changed
        if (now === null || !contains(now, was)) changed.add(detail);
      }),
    );
  } catch {
    // git missing, timed out, or a checkout in an odd state: report nothing rather than fail the read.
  }
  return changed;
}
