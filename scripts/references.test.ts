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

describe("code references (CTX-13)", () => {
  it("reads a file, a line or a range, an optional column, and a commit", async () => {
    const { parseCodeRef } = await import("./references");
    expect(parseCodeRef("src/db/schema.ts:120-140@345a746")).toEqual({ path: "src/db/schema.ts", from: 120, to: 140, commit: "345a746" });
    expect(parseCodeRef("a.ts:7:3@0123456789abcdef")).toEqual({ path: "a.ts", from: 7, to: 7, column: 3, commit: "0123456789abcdef" });
  });

  it("refuses what is not one: no commit, a backwards range, line zero, a URL", async () => {
    const { parseCodeRef } = await import("./references");
    for (const detail of ["src/a.ts:12", "src/a.ts:20-10@345a746", "src/a.ts:0@345a746", "https://example.com/a.ts#L1"]) {
      expect(parseCodeRef(detail), detail).toBeNull();
    }
  });
});

describe("the review's edge cases (CTX-13)", () => {
  it("keeps a stray backtick from hiding pointers, in its own paragraph or the next", () => {
    expect(Object.keys(covers("A lone ` here [ref a1].\n\nNext para with `code` [ref b2]."))).toEqual(["a1", "b2"]);
    expect(Object.keys(covers("The ` key works [ref a1]."))).toEqual(["a1"]);
  });

  it("never lets a code span cross a blank line", () => {
    expect(Object.keys(covers("Open `span [ref a1].\n\nclose` here [ref b2]."))).toEqual(["a1", "b2"]);
  });

  it("does not read a link, a link definition or an escaped pointer as a pointer", () => {
    expect(parsePointers("See the [ref docs](https://example.com).").pointers).toEqual([]);
    expect(parsePointers("[ref a1]: https://example.com").pointers).toEqual([]);
    expect(parsePointers("Literally \\[ref a1].").pointers).toEqual([]);
    expect(problems("See the [ref docs](https://example.com).")).toEqual([]);
  });

  it("says when a pointer has nothing before it to stand behind", () => {
    expect(problems("[ref a1] then the claim.")).toEqual(["[ref a1] has nothing before it to stand behind: put it straight after its claim"]);
    expect(problems("## [ref a1] Title")).toHaveLength(1);
  });

  it("asks for a blank line between a list and a pointer under it", () => {
    expect(problems("- a\n- b\n[ref a1]")).toContain("put a blank line between the list and [ref a1], or markdown reads it as part of the last item");
    expect(problems("- a\n- b\n\n[ref a1]")).toEqual([]);
  });

  it("ignores a blockquote's markers, so rewrapping a quote is not a change", () => {
    expect(covers("> quoted claim\n> more [ref a1]")).toEqual(covers("> quoted\n> claim more [ref a1]"));
  });

  it("says what a key is when a pointer is malformed", () => {
    expect(problems("As in [ref CTX-13].")).toEqual(['"[ref CTX-13]." is not a pointer: write [ref <key>], where a key is lowercase letters and digits']);
  });

  it("reads CRLF text, and stays fast on a long run of unclosed pointers", () => {
    expect(covers("A claim [ref a1].\r\n\r\nAnother [ref b2].")).toEqual({ a1: "A claim", b2: "Another" });
    const started = Date.now();
    parsePointers("[ref a1:".repeat(20_000));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("parsing the same text twice (CTX-13)", () => {
  it("answers from what it kept, and the answer cannot be changed by a caller", () => {
    const text = "A claim [ref c1]. Another [ref c2].";
    const first = parsePointers(text);
    expect(parsePointers(text)).toBe(first);
    expect(() => (first.pointers as unknown as unknown[]).sort()).toThrow();
  });
});

describe("hostile input (CTX-13)", () => {
  it("stays fast on a paragraph of many unmatched backticks", () => {
    const started = Date.now();
    parsePointers("a ` ".repeat(50_000) + "[ref a1]");
    parsePointers("b ` c `` ".repeat(20_000) + "[ref a2]");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
