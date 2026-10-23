/**
 * The ordering guarantee `ids.ts` exists to provide: ids minted in sequence sort in that sequence, as plain
 * text. Everything downstream leans on it - "most recent first" with no extra column, index-local inserts,
 * and any tie-break on a millisecond-precision `created_at`.
 */
import { describe, expect, it } from "vitest";
import { uuidv7, timestamp, sortPath } from "./ids";

describe("uuidv7", () => {
  it("stays ordered for ids minted inside one millisecond", () => {
    // The regression: this used to pass `msecs: Date.now()` to the uuid library on every call, which opts out
    // of its monotonic counter. Same-millisecond pairs then came out reversed about half the time, and the
    // only symptom was a notes list that occasionally returned two same-millisecond notes the wrong way round.
    // 500 iterations because a broken implementation fails ~50% of pairs, so this cannot pass by luck.
    const ids = Array.from({ length: 500 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
  });

  it("places an id at an injected instant, so ordering can be asserted across milliseconds", () => {
    const early = uuidv7(1_800_000_000_000);
    const late = uuidv7(1_800_000_001_000);
    expect(early < late).toBe(true);
  });
});

describe("timestamp", () => {
  it("is fixed-width ISO-8601 UTC, so text comparison orders correctly", () => {
    const early = timestamp(new Date("2026-07-28T09:05:00.000Z"));
    const late = timestamp(new Date("2026-07-28T14:47:00.000Z"));
    expect(early).toBe("2026-07-28T09:05:00.000Z");
    expect(early < late).toBe(true);
  });
});

describe("sortPath", () => {
  it("pads each segment so text ordering matches numeric ordering", () => {
    expect(sortPath("MCP-3.1.2")).toBe("000003.000001.000002");
    // The point of padding: "10" sorts before "9" as text, which would put MCP-10 before MCP-9 on the board.
    expect([sortPath("MCP-10"), sortPath("MCP-9"), sortPath("MCP-1.2")].sort()).toEqual([
      sortPath("MCP-1.2"),
      sortPath("MCP-9"),
      sortPath("MCP-10"),
    ]);
  });
});
