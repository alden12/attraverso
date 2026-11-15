import { describe, expect, it } from "vitest";
import { bareForm, normaliseClaim, parsePointers } from "./references";

const covers = (text: string) => Object.fromEntries(parsePointers(text).pointers.map((p) => [p.key, p.covers]));
const problems = (text: string) => parsePointers(text).problems.map((p) => p.problem);

describe("what a pointer covers (CTX-13)", () => {
  it("covers the text before it, back to the start of its paragraph", () => {
    expect(covers("Production runs on Postgres 18.4 [ref r7k2].")).toEqual({ r7k2: "Production runs on Postgres 18.4" });
  });

  it("starts after the previous pointer in the same paragraph, not at the paragraph's start", () => {
    const text = "The database runs Postgres 18.4 [ref r7k2]. The local target is pinned to it,\nso `yarn test:pg` stands in [ref t3w8].";
    expect(covers(text)).toEqual({ r7k2: "The database runs Postgres 18.4", t3w8: "The local target is pinned to it, so `yarn test:pg` stands in" });
  });

  it("covers only its own list item, or its heading", () => {
    expect(covers("- one claim [ref a1]\n- another claim [ref b2]")).toEqual({ a1: "one claim", b2: "another claim" });
    expect(covers("## Hosting is a VM [ref h1]\n\nbody")).toEqual({ h1: "Hosting is a VM" });
  });

  it("on its own line, covers the whole table or list above it", () => {
    const table = "| engine | version |\n| --- | --- |\n| main | 18.4 |\n\n[ref t1]\n[ref t2]";
    expect(covers(table)).toEqual({ t1: "engine | version --- | --- main | 18.4", t2: "engine | version --- | --- main | 18.4" });
    expect(covers("- first\n- second\n\n[ref l1]")).toEqual({ l1: "first second" });
  });

  it("ignores anything inside code, so documenting the syntax never trips it", () => {
    const text = "Write `[ref r7k2]` after a claim.\n\n```\nThe database runs 18.4 [ref zz99]\n```\n";
    expect(parsePointers(text).pointers).toEqual([]);
    expect(problems(text)).toEqual([]);
  });

  it("reads the expanded form get_item returns as the same pointer", () => {
    expect(covers("The database runs Postgres 18.6 [ref r7k2: search 2026-08-10, text changed since].")).toEqual({ r7k2: "The database runs Postgres 18.6" });
  });
});

describe("what a writer is told about", () => {
  it("a malformed pointer, but never a task box, a link or a footnote", () => {
    expect(problems("Broken [ref R7K2] and [ref ] here.")).toHaveLength(2);
    expect(problems("- [x] done, a [link](https://x.y) and a note[^1].")).toEqual([]);
  });

  it("the same key twice", () => {
    expect(problems("One [ref a1]. Two [ref a1].")).toEqual(["[ref a1] appears twice: a key stands behind one claim"]);
  });

  it("a pointer line directly under a table, which markdown reads as another row", () => {
    expect(problems("| a | b |\n| --- | --- |\n[ref t1]")[0]).toMatch(/blank line between the table/);
    expect(problems("| a | b |\n| --- | --- |\n\n[ref t1]")).toEqual([]);
  });
});

describe("the stored form", () => {
  it("reduces an expanded pointer to its bare form, and leaves code alone", () => {
    const sent = "The database runs 18.6 [ref r7k2: search 2026-08-10, text changed since]. Write `[ref x1: like this]`.";
    expect(bareForm(sent)).toBe("The database runs 18.6 [ref r7k2]. Write `[ref x1: like this]`.");
    expect(bareForm(bareForm(sent))).toBe(bareForm(sent));
  });

  it("compares claims without caring about wrapping, spacing or Unicode form", () => {
    expect(normaliseClaim("The  database runs\n Postgres 18.4")).toBe(normaliseClaim("The database runs Postgres 18.4"));
    expect(normaliseClaim("Café")).toBe(normaliseClaim("Café"));
  });
});
