/**
 * Where an item lands on the calendar (`CAL-3`). The dates are days, not instants (`CAL-1`), so these pin the
 * arithmetic that a time zone would otherwise get wrong: month and year ends, and a leap day.
 */
import { describe, expect, it } from "vitest";
import { countDated, nextDay, spanOf } from "./calendarDates";

describe("spanOf", () => {
  it("leaves an undated item off the calendar, which is the normal case", () => {
    expect(spanOf({})).toBeNull();
  });

  it("puts a due-only or start-only item on that one day", () => {
    expect(spanOf({ due: "2026-11-06" })).toEqual({ start: "2026-11-06", end: "2026-11-07" });
    expect(spanOf({ start: "2026-11-02" })).toEqual({ start: "2026-11-02", end: "2026-11-03" });
  });

  it("spans start to due inclusive, with the end exclusive as the calendar expects", () => {
    expect(spanOf({ start: "2026-11-02", due: "2026-11-06" })).toEqual({ start: "2026-11-02", end: "2026-11-07" });
  });

  it("puts a done item with no planned date on the day it closed, and lets a planned date win", () => {
    // Midday UTC, so the local day is the same one wherever the suite runs.
    expect(spanOf({ closed: "2026-09-02T12:00:00.000Z" })).toEqual({ start: "2026-09-02", end: "2026-09-03" });
    expect(spanOf({ due: "2026-08-30", closed: "2026-09-02T12:00:00.000Z" })).toEqual({ start: "2026-08-30", end: "2026-08-31" });
  });

  it("counts only the items that land somewhere", () => {
    expect(countDated([{}, { due: "2026-11-06" }, { start: "2026-11-02" }])).toBe(2);
  });
});

describe("nextDay", () => {
  it("crosses month and year ends, and knows a leap day", () => {
    expect(nextDay("2026-11-30")).toBe("2026-12-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
    expect(nextDay("2027-02-28")).toBe("2027-03-01");
  });
});
