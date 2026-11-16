/**
 * The `code` source check (`CTX-13`), against a real throwaway git repository: lines pinned at a commit, compared
 * with the file as it is now. What matters as much as finding a change is never inventing one - a commit the
 * checkout lacks, or no checkout at all, reports nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeDrift, MAX_CODE_CHECKS } from "./codeDrift";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

describe("code changed since (CTX-13)", () => {
  let repo: string;
  let commit: string;
  let plan: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "attraverso-code-"));
    git(repo, "init", "-q");
    await writeFile(join(repo, "lib.ts"), "export const one = 1;\nexport const two = 2;\n// naïve café\nexport const three = 3;\n");
    plan = join(repo, "attraverso.yaml");
    await writeFile(plan, "projects: []\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "first");
    commit = git(repo, "rev-parse", "--short", "HEAD");
    // Line 2 changes after the commit; lines 1 and 3 do not.
    await writeFile(join(repo, "lib.ts"), "export const one = 1;\nexport const two = 22;\n// naïve café\nexport const three = 3;\n");
  });
  afterAll(async () => rm(repo, { recursive: true, force: true }));

  const code = (detail: string) => ({ source: "code", detail });

  it("reports the lines that changed since the pinned commit, and not the ones that did not", async () => {
    const changed = await codeDrift(plan, [code(`lib.ts:2@${commit}`), code(`lib.ts:1@${commit}`), code(`lib.ts:3-4@${commit}`)]);
    expect([...changed]).toEqual([`lib.ts:2@${commit}`]);
  });

  it("reports a file deleted since", async () => {
    await writeFile(join(repo, "gone.ts"), "x\n");
    git(repo, "add", "gone.ts");
    git(repo, "commit", "-q", "-m", "add");
    const added = git(repo, "rev-parse", "--short", "HEAD");
    git(repo, "rm", "-q", "gone.ts");
    expect([...(await codeDrift(plan, [code(`gone.ts:1@${added}`)]))]).toEqual([`gone.ts:1@${added}`]);
  });

  it("reports nothing it cannot check: a commit the checkout lacks, other kinds of source, or no checkout", async () => {
    expect((await codeDrift(plan, [code("lib.ts:2@deadbee")])).size).toBe(0);
    expect((await codeDrift(plan, [{ source: "docs", detail: "lib.ts" }])).size).toBe(0);
    expect((await codeDrift(undefined, [code(`lib.ts:2@${commit}`)])).size).toBe(0);
    expect((await codeDrift(join(tmpdir(), "nowhere", "attraverso.yaml"), [code(`lib.ts:2@${commit}`)])).size).toBe(0);
  });

  it("does not flag lines that only moved, as when an import is added above them", async () => {
    await writeFile(join(repo, "lib.ts"), "import x from 'x';\nexport const one = 1;\nexport const two = 22;\n// naïve café\nexport const three = 3;\n");
    expect((await codeDrift(plan, [code(`lib.ts:1@${commit}`), code(`lib.ts:3-4@${commit}`)])).size).toBe(0);
    expect([...(await codeDrift(plan, [code(`lib.ts:2@${commit}`)]))]).toEqual([`lib.ts:2@${commit}`]);
  });

  it("keeps its place in git's output past a directory, a missing file and an unknown commit", async () => {
    const batch = [code(`.:1@${commit}`), code(`nope.ts:1@${commit}`), code("lib.ts:2@deadbee"), code(`lib.ts:2@${commit}`), code(`lib.ts:1@${commit}`)];
    expect([...(await codeDrift(plan, batch))]).toEqual([`lib.ts:2@${commit}`]);
  });

  it("is refused at write for a path outside the repo, so it can never spoil a batch", async () => {
    const { parseCodeRef } = await import("../../scripts/references");
    expect(parseCodeRef(`../x.ts:1@${commit}`)).toBeNull();
    expect(parseCodeRef(`/etc/passwd:1@${commit}`)).toBeNull();
    expect(parseCodeRef(`src\\x.ts:1@${commit}`)).toBeNull();
    expect(parseCodeRef(`app/[id]/page.tsx:1@${commit}`)).not.toBeNull();
  });

  it("checks a source in a repo nested inside the plan's folder against that repo (CTX-17.6)", async () => {
    // A plan at the top of a folder of repos: the outer one ignores the inner, whose commit it has never seen.
    const inner = join(repo, "inner");
    await mkdir(inner);
    git(inner, "init", "-q");
    await writeFile(join(inner, "v.txt"), "1.0\n");
    git(inner, "add", ".");
    git(inner, "commit", "-q", "-m", "inner");
    const innerCommit = git(inner, "rev-parse", "--short", "HEAD");
    await writeFile(join(inner, "v.txt"), "2.0\n");
    const nested = code(`inner/v.txt:1@${innerCommit}`);
    expect([...(await codeDrift(plan, [nested, code(`lib.ts:2@${commit}`)]))].sort()).toEqual([`inner/v.txt:1@${innerCommit}`, `lib.ts:2@${commit}`].sort());

    // And with the plan in a folder that is no repo at all, beside the repos it cites.
    const folder = await mkdtemp(join(tmpdir(), "attraverso-folder-"));
    try {
      await rename(inner, join(folder, "inner"));
      expect([...(await codeDrift(join(folder, "attraverso.yaml"), [nested]))]).toEqual([`inner/v.txt:1@${innerCommit}`]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("checks at most MAX_CODE_CHECKS sources on one read", async () => {
    // Every one of these has changed (line 2 of the file it pins); only the first MAX_CODE_CHECKS are looked at.
    const many = Array.from({ length: MAX_CODE_CHECKS + 5 }, (_, i) => code(`lib.ts:2:${i + 1}@${commit}`));
    expect((await codeDrift(plan, many)).size).toBe(MAX_CODE_CHECKS);
  });
});
