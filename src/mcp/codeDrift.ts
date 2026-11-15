/**
 * Whether the code a `code` source pinned has changed since (`CTX-13`): the lines at the pinned commit against the
 * same lines of the file as it is now.
 *
 * **Only where it is cheap and possible, and only when an item is read.** The pinned lines are fetched for every
 * source in one `git cat-file --batch` process (measured 2026-11-15: about 0.25 ms a file batched, 2 ms spawning git
 * per file), so a read with a few code references pays a few milliseconds. A host with no checkout - the hosted
 * server - never calls this, and in a checkout without the pinned commit (a shallow clone: CI, a cloud session) the
 * source is simply not reported: unknown is not changed. The reference still says exactly what a claim rests on, so
 * an agent relying on it can run the `git show` itself.
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
    const child = execFile("git", args, { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 5000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
    if (input !== undefined) child.stdin?.end(input);
  });

/** The checkout a plan file sits in, or null when it is not in one (or git is not there to ask). */
async function checkoutOf(planPath: string): Promise<string | null> {
  try {
    return (await run(["rev-parse", "--show-toplevel"], dirname(planPath))).toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

/** `git cat-file --batch` output for `commit:path` objects, by request, null for each one git does not have. */
async function blobsAt(root: string, refs: CodeRef[]): Promise<(string | null)[]> {
  const requests = refs.map((ref) => `${ref.commit}:${ref.path}`);
  const out = await run(["cat-file", "--batch"], root, requests.join("\n") + "\n");
  const blobs: (string | null)[] = [];
  let at = 0;
  for (let i = 0; i < requests.length; i++) {
    const end = out.indexOf(10, at); // the header line
    const header = out.subarray(at, end).toString();
    at = end + 1;
    const size = /^\S+ blob (\d+)$/.exec(header);
    if (size === null) {
      blobs.push(null); // "<request> missing", or not a file: unknown here
      continue;
    }
    blobs.push(out.subarray(at, at + Number(size[1])).toString("utf8"));
    at += Number(size[1]) + 1; // the blob, then its trailing newline
  }
  return blobs;
}

/** Lines `from` to `to` (1-based, inclusive), trailing whitespace ignored, or null when the file is shorter. */
function lines(text: string, from: number, to: number): string | null {
  const all = text.split("\n");
  if (to > all.length) return null;
  return all
    .slice(from - 1, to)
    .map((line) => line.trimEnd())
    .join("\n");
}

/**
 * The details of the `code` sources whose pinned lines differ from the file now, in the checkout holding
 * `planPaths[0]`. Empty when there is no checkout or no code source; never throws, since a read must not fail over
 * an optional check.
 */
export async function codeDrift(planPaths: readonly string[] | undefined, sources: { source: string; detail: string }[]): Promise<Set<string>> {
  const changed = new Set<string>();
  const code = [...new Set(sources.filter((s) => s.source === "code").map((s) => s.detail))].flatMap((detail) => {
    const ref = parseCodeRef(detail);
    return ref === null ? [] : [{ detail, ref }];
  });
  if (code.length === 0 || planPaths === undefined || planPaths.length === 0) return changed;
  try {
    const root = await checkoutOf(planPaths[0]!);
    if (root === null) return changed;
    const pinned = await blobsAt(
      root,
      code.map((c) => c.ref),
    );
    await Promise.all(
      code.map(async ({ detail, ref }, index) => {
        const then = pinned[index];
        if (then === null || then === undefined) return; // the commit is not in this checkout: unknown, not changed
        const was = lines(then, ref.from, ref.to);
        const now = await readFile(join(root, ref.path), "utf8").then(
          (text) => lines(text, ref.from, ref.to),
          () => null, // deleted or moved since: changed
        );
        if (was !== null && was !== now) changed.add(detail);
      }),
    );
  } catch {
    // git missing, timed out, or a checkout in an odd state: report nothing rather than fail the read.
  }
  return changed;
}
