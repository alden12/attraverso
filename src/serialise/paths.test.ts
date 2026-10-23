/**
 * What a plan file is called, and where its data folder is (`IMP-20`).
 */
import { describe, expect, it } from "vitest";
import { dataDirFor, isLegacyStore, isStoreFile } from "./paths";

describe("plan file names (IMP-20)", () => {
  it("recognises the new name and the legacy suffix, and nothing else", () => {
    expect(isStoreFile("attraverso.yaml")).toBe(true);
    expect(isStoreFile("roadmap.apm.yaml")).toBe(true);
    // Discovery walks up a whole tree, so an ordinary YAML file must never read as a plan.
    expect(isStoreFile("docker-compose.yml")).toBe(false);
    expect(isStoreFile("config.yaml")).toBe(false);
  });

  it("keeps a legacy plan's data in .apm/, and gives every other name .attraverso/", () => {
    // A legacy plan must not lose its measurements to the rename; the folder moves when the file does.
    expect(dataDirFor("/repo/roadmap.apm.yaml")).toBe("/repo/.apm");
    expect(dataDirFor("/repo/attraverso.yaml")).toBe("/repo/.attraverso");
    // A name given with --store is new-style too: only the old suffix means the old folder.
    expect(dataDirFor("/repo/spanish.yaml")).toBe("/repo/.attraverso");
    expect(isLegacyStore("/repo/attraverso.yaml")).toBe(false);
  });
});
