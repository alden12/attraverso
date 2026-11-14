import { describe, expect, it } from "vitest";
import type { RoadmapItem, Status } from "../scripts/tickets";
import { BOARD_COLUMNS, dateLanes, orderCell } from "./Board";

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

describe("the board by date (VIEW-46)", () => {
  const at = (id: string, created: string | undefined): RoadmapItem => ({ ...item(id), ...(created === undefined ? {} : { created }) });
  const now = new Date(2026, 10, 14, 15, 0); // 14 Nov 2026, 3pm local

  it("buckets into today, this week, the last 30 days, then months, newest first, undated last", () => {
    const local = (y: number, m: number, d: number) => new Date(y, m, d, 12).toISOString();
    const lanes = dateLanes(
      [at("A-1", local(2026, 10, 14)), at("A-2", local(2026, 10, 10)), at("A-3", local(2026, 9, 25)), at("A-4", local(2026, 7, 3)), at("A-5", undefined), at("A-6", local(2026, 10, 14))],
      "created",
      now,
    );
    expect(lanes.map((lane) => lane.key)).toEqual(["d:today", "d:week", "d:month", "d:2026-08", "d:none"]);
    expect(lanes[0]!.items.map((entry) => entry.id)).toHaveLength(2);
  });

  it("runs a lane newest first", () => {
    const lanes = dateLanes([at("A-1", "2026-11-14T09:00:00Z"), at("A-2", "2026-11-14T13:00:00Z")], "created", new Date("2026-11-14T15:00:00Z"));
    expect(lanes[0]!.items.map((entry) => entry.id)).toEqual(["A-2", "A-1"]);
  });
});
