/**
 * The four states VIEW-4 has to get right. They are one rule: never choose silently among alternatives. The
 * bug being fixed was `store.projects[0]`, which did exactly that, and each case here is a way of doing it
 * again by accident.
 */
import { describe, expect, it } from "vitest";
import { selectProject, type ProjectPlan } from "./store";

const project = (key: string): ProjectPlan => ({ key, name: key.toUpperCase(), items: [], next: [], bodies: new Map(), attachments: new Map(), metrics: new Map() });
const apm = project("apm");
const spanish = project("spanish");

describe("selectProject", () => {
  it("renders the only project without asking, since there is no ambiguity to resolve", () => {
    expect(selectProject([apm], null)).toEqual({ project: apm, notice: null });
  });

  it("prompts rather than picking one when several could be meant", () => {
    const selection = selectProject([apm, spanish], null);
    expect(selection.project).toBeNull();
    expect(selection.notice).toContain("Choose one");
  });

  it("renders the project named in the hash", () => {
    expect(selectProject([apm, spanish], "spanish")).toEqual({ project: spanish, notice: null });
  });

  it("says an unknown key is unknown, and what is there, instead of falling back", () => {
    const selection = selectProject([apm, spanish], "german");
    expect(selection.project).toBeNull();
    expect(selection.notice).toContain('No project "german"');
    expect(selection.notice).toContain("apm, spanish");
  });

  it("treats an empty store as a first run, hash or no hash", () => {
    for (const requested of [null, "apm"]) {
      const selection = selectProject([], requested);
      expect(selection.project).toBeNull();
      expect(selection.notice).toContain("no projects yet");
    }
  });
});
