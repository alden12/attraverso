/**
 * Replay a plan's git history through the graph layout and measure how much it reshuffles (`VIEW-23.1`).
 *
 * The question `VIEW-23` says to settle by measurement rather than argument: as a plan grows, do things stay
 * where they were? Each committed version of the plan file is laid out exactly as the viewer would lay it out,
 * and each consecutive pair is compared by `compareLayouts` - the share of item pairs, and of area pairs, whose
 * left/right or above/below order flipped. A CLI, so stdout is fine.
 *
 *   yarn workspace attraverso layout:history [--project <key>] [--file attraverso.yaml --file roadmap.apm.yaml]
 *
 * Run from a checkout with history: a shallow clone (CI's, a cloud session's) has a handful of versions at
 * most, so deepen it first (`git fetch --depth=2000 origin master`). The paths are relative to the git root and
 * every one is tried at each commit, which is how a plan that was renamed is followed across the rename.
 */
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { compareLayouts, currentLayout, describe, summarise, type Stability } from "../roadmap/layoutStability";
import { asPlan, type Store } from "../src/serialise/plan";
import { areasOf, type RoadmapItem, type Status } from "./tickets";

const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** The items one project renders, through the same projection the server serves (`asPlan`) and the same mapping
 *  the viewer applies to it (`fetchPlan`), so the replay lays out what the viewer would have drawn. */
export function itemsOf(store: Store, project: string | undefined): RoadmapItem[] | null {
  const projects = asPlan(store).projects ?? [];
  const found = project === undefined ? projects[0] : projects.find((candidate) => candidate.key === project);
  if (!found) return null;
  return (found.items ?? []).map((item) => ({
    id: item.ref,
    area: item.area,
    status: item.status as Status,
    title: item.title,
    deps: item.deps ?? [],
    parent: item.parent ?? null,
  }));
}

function argValues(flag: string): string[] {
  const values: string[] = [];
  process.argv.forEach((arg, index) => {
    if (arg === flag && process.argv[index + 1]) values.push(process.argv[index + 1]!);
  });
  return values;
}

function main(): void {
  const project = argValues("--project")[0]; // the first project in the file when not given
  const files = argValues("--file");
  const paths = files.length > 0 ? files : ["attraverso.yaml", "roadmap.apm.yaml"];
  const root = git("rev-parse", "--show-toplevel").trim();
  const commits = git("-C", root, "log", "--format=%H", "--reverse", "--first-parent", "HEAD", "--", ...paths)
    .split("\n")
    .filter(Boolean);

  const versions: RoadmapItem[][] = [];
  for (const commit of commits) {
    for (const path of paths) {
      let text: string;
      try {
        text = execFileSync("git", ["-C", root, "show", `${commit}:${path}`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        continue; // not at this path in this commit
      }
      const items = itemsOf(parse(text) as Store, project);
      if (items && items.length > 0) versions.push(items);
      break;
    }
  }
  if (versions.length < 2) {
    console.error(`layout:history: found ${versions.length} version(s) of project ${project ?? "(the first)"} in ${paths.join(", ")}; a shallow clone needs deepening`);
    process.exit(1);
  }

  const areaResults: Stability[] = [];
  const itemResults: Stability[] = [];
  let previous = currentLayout(versions[0]!);
  for (const items of versions.slice(1)) {
    const frame = currentLayout(items);
    areaResults.push(compareLayouts(previous.rects, frame.rects, frame.areas));
    itemResults.push(compareLayouts(previous.rects, frame.rects, frame.items));
    previous = frame;
  }
  const last = versions[versions.length - 1]!;
  console.log(`${versions.length} versions of ${project ?? "the first project"}, ${versions[0]!.length} to ${last.length} items, ${areasOf(last).length} areas at the end`);
  console.log(describe("areas", summarise(areaResults)));
  console.log(describe("items", summarise(itemResults)));
}

main();
