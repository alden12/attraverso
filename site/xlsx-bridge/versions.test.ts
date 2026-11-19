/**
 * Which spreadsheet in the folder the bridge shows (`DIST-9.1`): the newest version of the plan, as an assistant
 * that can only save new files names them (`plan_v2.xlsx`, `plan_v3.xlsx`).
 */
import { describe, expect, it } from "vitest";
import { newest, versionOf } from "./versions";

const at = (name: string, modified: number) => ({ name, modified });

describe("the newest version of the plan (DIST-9.1)", () => {
  it("reads a plan name and version from a file name, and ignores anything else", () => {
    expect(versionOf(at("plan.xlsx", 1))).toMatchObject({ base: "plan", version: 1 });
    expect(versionOf(at("plan_v12.xlsx", 1))).toMatchObject({ base: "plan", version: 12 });
    expect(versionOf(at("my_plan_v3.XLSX", 1))).toMatchObject({ base: "my_plan", version: 3 });
    expect(versionOf(at("~$plan.xlsx", 1))).toBeNull(); // Excel's lock file
    expect(versionOf(at("notes.txt", 1))).toBeNull();
  });

  it("picks the highest version, not the latest change, once the plan is known", () => {
    const folder = [at("plan.xlsx", 50), at("plan_v2.xlsx", 10), at("plan_v10.xlsx", 20), at("other.xlsx", 99)];
    expect(newest(folder, "plan")?.file).toBe("plan_v10.xlsx");
  });

  it("starts from whichever plan changed last, and finds nothing for a plan with no file", () => {
    expect(newest([at("old.xlsx", 1), at("plan.xlsx", 5), at("plan_v2.xlsx", 3)])?.file).toBe("plan_v2.xlsx");
    expect(newest([at("plan.xlsx", 1)], "gone")).toBeNull();
    expect(newest([])).toBeNull();
  });
});
