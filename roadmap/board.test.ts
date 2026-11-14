import { describe, expect, it } from "vitest";
import type { RoadmapItem, Status } from "../scripts/tickets";
import { BOARD_COLUMNS, orderCell } from "./Board";

const item = (id: string, status: Status = "to-do", closed?: string): RoadmapItem => ({
  id,
  area: id.split("-")[0]!,
  status,
  title: id,
  deps: [],
  parent: null,
  ...(closed === undefined ? {} : { closed }),
});

describe("the board (VIEW-46)", () => {
  it("runs its columns in the order work moves through them", () => {
    expect(BOARD_COLUMNS).toEqual(["planning", "to-do", "in-progress", "review", "done"]);
  });

  it("puts the next list's items first in their agreed order, then the rest in plan order", () => {
    const plan = ["A-1", "A-2", "A-3", "A-4"].map((id) => item(id));
    expect(orderCell(plan, ["A-3", "A-1"], plan).map((entry) => entry.id)).toEqual(["A-3", "A-1", "A-2", "A-4"]);
  });

  it("lists done newest first, since the agreed order no longer applies to it", () => {
    const plan = [item("A-1", "done", "2026-11-01T00:00:00Z"), item("A-2", "done", "2026-11-10T00:00:00Z")];
    expect(orderCell(plan, ["A-1"], plan).map((entry) => entry.id)).toEqual(["A-2", "A-1"]);
  });
});
