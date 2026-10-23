/**
 * Context-memory domain tests: sections (set, revise-in-place, order), and resume assembling the pack.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb } from "../db/testing";
import type { OwnedProjectId } from "./owned";
import { events, comments } from "../db/schema";
import { createProject, setDirection } from "./projects";
import { createItem, setStatus } from "./items";
import { setNext } from "./next";
import { deleteSection, getSection, listSections, setSection, PROTOCOL_HEADING } from "./context";
import { addComment, deleteComment, editComment, listComments, MAX_BODY, shortCommentId } from "./comments";
import { FULL_BOARD_LIMIT, resumeProject } from "./memory";

const ACTOR = "test";

/** A project-level comment, inserted the way the importer does. `addComment` refuses these since `CTX-15`, so
 *  a test about reading legacy ones has to arrive by the same route they now only ever arrive by. */
const legacyProjectComment = (db: Awaited<ReturnType<typeof freshDb>>["db"], projectId: string, body: string, audience = "user") =>
  db.insert(comments).values({ projectId, itemId: null, body, audience, actor: ACTOR });
const project = (db: Awaited<ReturnType<typeof freshDb>>["db"], ownerId: string) =>
  createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId }, ACTOR);

describe("section ordering (CTX-11)", () => {
  const headings = async (db: Parameters<typeof listSections>[0], projectId: OwnedProjectId): Promise<string[]> =>
    (await listSections(db, projectId)).map((s) => s.heading);

  it("appends by default and keeps a section where it is when its content is revised", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const h of ["Thesis", "Storage", "Licensing"]) await setSection(db, { projectId: p.id, heading: h, content: h }, ACTOR);
    await setSection(db, { projectId: p.id, heading: "Thesis", content: "rewritten" }, ACTOR);
    // Revising must not reorder: the sections are read back in this order by every session, so a content edit
    // that silently moved one would rearrange the argument.
    expect(await headings(db, p.id)).toEqual(["Thesis", "Storage", "Licensing"]);
    await close();
  });

  it("places a section after a named one, and at the front", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const h of ["Thesis", "Storage", "Licensing"]) await setSection(db, { projectId: p.id, heading: h, content: h }, ACTOR);

    await setSection(db, { projectId: p.id, heading: "Model", content: "m", after: "Thesis" }, ACTOR);
    expect(await headings(db, p.id)).toEqual(["Thesis", "Model", "Storage", "Licensing"]);

    await setSection(db, { projectId: p.id, heading: "Goal", content: "g", after: null }, ACTOR);
    expect(await headings(db, p.id)).toEqual(["Goal", "Thesis", "Model", "Storage", "Licensing"]);
    await close();
  });

  it("moves an existing section rather than only placing a new one", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const h of ["Thesis", "Storage", "Licensing"]) await setSection(db, { projectId: p.id, heading: h, content: h }, ACTOR);
    await setSection(db, { projectId: p.id, heading: "Licensing", content: "l", after: "Thesis" }, ACTOR);
    expect(await headings(db, p.id)).toEqual(["Thesis", "Licensing", "Storage"]);
    await close();
  });

  it("keeps working when positions are packed tight, which is the case that needs the renumber", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (const h of ["A", "B", "C"]) await setSection(db, { projectId: p.id, heading: h, content: h }, ACTOR);
    // Repeatedly inserting into the same gap exhausts the integer room between A and B.
    for (const h of ["X", "Y", "Z", "W"]) await setSection(db, { projectId: p.id, heading: h, content: h, after: "A" }, ACTOR);
    expect(await headings(db, p.id)).toEqual(["A", "W", "Z", "Y", "X", "B", "C"]);
    await close();
  });

  it("refuses an anchor that does not exist rather than appending and looking like it worked", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await setSection(db, { projectId: p.id, heading: "Thesis", content: "t" }, ACTOR);
    await expect(setSection(db, { projectId: p.id, heading: "New", content: "n", after: "Nope" }, ACTOR)).rejects.toThrow(/no context section "Nope"/);
    await close();
  });
});

describe("context sections", () => {
  it("sets by heading, revises in place, and logs created then updated", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await setSection(db, { projectId: p.id, heading: "Goals", content: "ship the MVP" }, ACTOR);
    const revised = await setSection(db, { projectId: p.id, heading: "Goals", content: "ship the MVP, then dogfood" }, ACTOR);
    const sections = await listSections(db, p.id);
    expect(sections).toHaveLength(1); // same heading revised, not duplicated
    expect(revised.content).toBe("ship the MVP, then dogfood");
    const kinds = (await db.select().from(events).where(eq(events.entityType, "context_section"))).map((e) => e.kind);
    expect(kinds).toEqual(["created", "updated"]);
    await close();
  });

  it("keeps sections in the order they were introduced", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await setSection(db, { projectId: p.id, heading: "Goals", content: "a" }, ACTOR);
    await setSection(db, { projectId: p.id, heading: "Open questions", content: "b" }, ACTOR);
    await setSection(db, { projectId: p.id, heading: "Assumptions", content: "c" }, ACTOR);
    await setSection(db, { projectId: p.id, heading: "Goals", content: "a2" }, ACTOR); // revise keeps position
    expect((await listSections(db, p.id)).map((s) => s.heading)).toEqual(["Goals", "Open questions", "Assumptions"]);
    await close();
  });

  it("reads a single section by heading, and returns null for an unknown one", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await setSection(db, { projectId: p.id, heading: "Goals", content: "ship it" }, ACTOR);
    expect((await getSection(db, p.id, "Goals"))?.content).toBe("ship it");
    expect(await getSection(db, p.id, "Nope")).toBeNull();
    await close();
  });

  it("deletes a section by heading, logs it, and rejects an unknown heading", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await setSection(db, { projectId: p.id, heading: "Scratch", content: "temporary" }, ACTOR);
    const removed = await deleteSection(db, p.id, "Scratch", ACTOR);
    expect(removed.heading).toBe("Scratch");
    expect(await listSections(db, p.id)).toHaveLength(0);
    await expect(deleteSection(db, p.id, "Nope", ACTOR)).rejects.toThrow(/no context section/);
    const kinds = (await db.select().from(events).where(eq(events.entityType, "context_section"))).map((e) => e.kind);
    expect(kinds).toEqual(["created", "deleted"]); // the failed delete logged nothing
    await close();
  });
});

describe("resume", () => {
  it("assembles direction, sections and open tickets", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await setDirection(db, p.id, "Durable project memory", ACTOR);
    await setSection(db, { projectId: p.id, heading: "Open questions", content: "how to split files?" }, ACTOR);
    await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    const done = await createItem(db, { projectId: p.id, area: "DATA", title: "schema", status: "done" }, ACTOR);

    const pack = await resumeProject(db, p.id);
    expect(pack.project.direction).toBe("Durable project memory");
    // Named, not carried (CTX-4): the pack is an index, and the body is one get_context away.
    expect(pack.sectionHeadings).toEqual(["Open questions"]);
    // Two open items is well under FULL_BOARD_LIMIT, so the whole board is carried, as it always was.
    expect(pack.board).toEqual({ kind: "full", items: [{ ref: "MCP-1", status: "to-do", title: "server" }] }); // DATA-1 is done, excluded
    expect(done.status).toBe("done");
    await close();
  });

  it("keeps carrying the whole board up to FULL_BOARD_LIMIT, then trims to the two groups (PROJ-8)", async () => {
    // A threshold rather than a truncation: the first 30 of 128 by (area, sort_path) would be an alphabetical
    // prefix presented as a board. So the board is carried whole or replaced, and never sliced.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (let n = 0; n < FULL_BOARD_LIMIT; n++) await createItem(db, { projectId: p.id, area: "MCP", title: `t${n}` }, ACTOR);
    expect((await resumeProject(db, p.id)).board.kind).toBe("full");

    await createItem(db, { projectId: p.id, area: "MCP", title: "one over" }, ACTOR);
    expect((await resumeProject(db, p.id)).board.kind).toBe("trimmed");
    await close();
  });

  it("shows what is in flight and what was agreed next, and counts the rest by status (PROJ-8)", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (let n = 0; n < FULL_BOARD_LIMIT + 1; n++) await createItem(db, { projectId: p.id, area: "MCP", title: `t${n}` }, ACTOR);
    await setStatus(db, { projectId: p.id, ref: "MCP-1", status: "in-progress" }, ACTOR);
    await setStatus(db, { projectId: p.id, ref: "MCP-2", status: "in-progress" }, ACTOR);
    await setStatus(db, { projectId: p.id, ref: "MCP-3", status: "planning" }, ACTOR);
    await setNext(db, p.id, ["MCP-4", "MCP-2"], ACTOR);

    const { board } = await resumeProject(db, p.id);
    if (board.kind !== "trimmed") throw new Error("expected a trimmed board");
    // MCP-2 is both in flight and agreed next: it appears once, under `next`, where the ordering is the point.
    expect(board.inProgress.map((i) => i.ref)).toEqual(["MCP-1"]);
    expect(board.next.map((n) => n.ref)).toEqual(["MCP-4", "MCP-2"]);
    // Exactly the open items not listed above, so the count can never overlap what was just printed.
    expect(board.held.total).toBe(FULL_BOARD_LIMIT + 1 - 3);
    expect(board.held.byStatus).toEqual([
      { status: "to-do", count: FULL_BOARD_LIMIT + 1 - 4 },
      { status: "planning", count: 1 },
    ]);
    await close();
  });

  it("says an order was never recorded rather than falling back to a slice of the backlog (PROJ-8)", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    for (let n = 0; n < FULL_BOARD_LIMIT + 1; n++) await createItem(db, { projectId: p.id, area: "MCP", title: `t${n}` }, ACTOR);

    const { board } = await resumeProject(db, p.id);
    if (board.kind !== "trimmed") throw new Error("expected a trimmed board");
    expect(board.inProgress).toEqual([]);
    expect(board.next).toEqual([]);
    expect(board.held.total).toBe(FULL_BOARD_LIMIT + 1); // everything is held, and the reply has to say so
    await close();
  });

  it("carries the protocol in full and every other section by name only (CTX-4)", async () => {
    // The one asymmetry in the pack, and it is deliberate: `protocol` is read-every-session by design
    // (CTX-9), while the rest is reference material that was being paid for constantly and consulted
    // occasionally - 21kB of a 55kB pack when this was measured.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await setSection(db, { projectId: p.id, heading: "Goals", content: "reach B1" }, ACTOR);
    await setSection(db, { projectId: p.id, heading: PROTOCOL_HEADING, content: "how to run a session" }, ACTOR);
    await setSection(db, { projectId: p.id, heading: "The storage model", content: "PGlite, rebuilt from YAML" }, ACTOR);

    const pack = await resumeProject(db, p.id);
    expect(pack.protocol).toBe("how to run a session");
    expect(pack.sectionHeadings).toEqual(["Goals", "The storage model"]); // protocol is not repeated here
    expect(JSON.stringify(pack)).not.toContain("reach B1"); // no other section's content rides along
    await close();
  });

  it("counts what it is holding back, so the reply can name it (CTX-4)", async () => {
    // Truncation is always announced. With comments dropped entirely and section bodies held, an agent that
    // does not know to look is the exact failure MCP-24 was filed about.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await setSection(db, { projectId: p.id, heading: "Goals", content: "reach B1" }, ACTOR);
    const held = await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    await addComment(db, { projectId: p.id, body: "one", itemId: held.id }, ACTOR);
    await addComment(db, { projectId: p.id, body: "two", itemId: held.id }, ACTOR);

    const pack = await resumeProject(db, p.id);
    expect(pack.held).toEqual({ sections: 1, comments: 2 });
    // Comments are not in the pack at all any more: they were 28kB of 55kB, chosen by recency alone, and
    // get_item already returns a ticket's own comments at the moment someone is looking at it.
    expect(JSON.stringify(pack)).not.toContain("one");
    await close();
  });

});

describe("comments", () => {
  it("appends a comment, attaches it to an item, and logs it", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    const item = await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    const comment = await addComment(db, { projectId: p.id, body: "reached for the conditional, could not say it", itemId: item.id }, ACTOR);

    expect(comment.itemId).toBe(item.id);
    expect(comment.audience).toBe("user"); // the default: a comment is for the human unless said otherwise
    const logged = await db.select().from(events).where(eq(events.entityId, comment.id));
    expect(logged.map((e) => e.kind)).toEqual(["created"]);
    await close();
  });

  it("refuses a comment over the cap, and names where the content should go instead (CTX-2)", async () => {
    // The measurement behind the cap: 64 of 64 comments ignored a description asking for "a sentence or two",
    // averaging 2.3kB. A softer signal will not beat a hard signal that was already disregarded, so the word
    // "comment" is backed by a refusal - and the refusal has to name a destination, or it loses the content
    // rather than relocating it.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    // Attached to a ticket, which is what earns the tight cap: the refusal names `edit_item`, so there has
    // to be a ticket for it to name.
    const item = await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    const essay = "x".repeat(MAX_BODY + 1);

    await expect(addComment(db, { projectId: p.id, body: essay, itemId: item.id }, ACTOR)).rejects.toThrow(/edit_item/);
    await expect(addComment(db, { projectId: p.id, body: essay, itemId: item.id }, ACTOR)).rejects.toThrow(new RegExp(`${MAX_BODY}`));
    // **And offers nothing else.** The refusal ended "Otherwise, shorten it" for a fortnight, and what agents
    // observably did was shorten - a little at a time, until it fit - which is this cap's own thesis happening
    // to the cap: trimming costs one retry and `edit_item` costs a read and an edit, so naming both picks the
    // cheap one every time. One destination, or the escape hatch is the whole feature.
    await expect(addComment(db, { projectId: p.id, body: essay, itemId: item.id }, ACTOR)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringMatching(/shorten|shorter|trim/i) as unknown as string }),
    );
    // Exactly at the cap is fine: the boundary is inclusive, so a comment written to the stated limit is not
    // refused for being the length it was told it could be.
    const atLimit = await addComment(db, { projectId: p.id, body: "x".repeat(MAX_BODY), itemId: item.id }, ACTOR);
    expect(atLimit.body).toHaveLength(MAX_BODY);
    await close();
  });

  it("tells 'any comment' from 'only the unattached ones' (CTX-15)", async () => {
    // These were the same value once: `null` meant "no filter", which reads as a filter. Nothing hit it
    // because the only caller passing null meant "any" - but "just the log" is a real query on a project
    // whose entries all hang off the project rather than a ticket, and it could not be written.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    const item = await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    await addComment(db, { projectId: p.id, body: "on the ticket", itemId: item.id }, ACTOR);
    await legacyProjectComment(db, p.id, "the daily log");

    expect((await listComments(db, { projectId: p.id })).map((c) => c.body)).toEqual(["the daily log", "on the ticket"]);
    expect((await listComments(db, { projectId: p.id, itemId: null })).map((c) => c.body)).toEqual(["the daily log"]);
    expect((await listComments(db, { projectId: p.id, itemId: item.id })).map((c) => c.body)).toEqual(["on the ticket"]);
    await close();
  });

  it("refuses a comment with no item, and names where the content belongs (CTX-15)", async () => {
    // The project this was found on kept a daily log entry attached to the project rather than to any
    // item - ~750 characters each, one per day. Those are measurements written as prose, and METRIC-2 built
    // the table and tools they belong in, so the destination now exists and the refusal can point at it.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    const item = await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);

    const refusal = addComment(db, { projectId: p.id, body: "Sleep: bed 11pm. Totals: 2,024 kcal." }, ACTOR);
    // Three destinations, not a bare no: CTX-2 learned from the cap that a refusal without one loses content
    // instead of relocating it. This refusal IS the migration trigger, since converting prose to readings
    // needs an agent reading each entry and there is no script to run.
    await expect(refusal).rejects.toThrow(/record_measurements/);
    await expect(refusal).rejects.toThrow(/set_context/);

    // Length is checked second, so a 2kB daily log is told where it belongs rather than told to shorten it -
    // the wrong instruction, and the one that produced 64 essays last time.
    await expect(addComment(db, { projectId: p.id, body: "x".repeat(MAX_BODY + 400) }, ACTOR)).rejects.toThrow(/record_measurements/);
    // With an item it is an ordinary comment again, capped as ever.
    await expect(addComment(db, { projectId: p.id, body: "x".repeat(MAX_BODY + 400), itemId: item.id }, ACTOR)).rejects.toThrow(/edit_item/);
    await close();
  });

  it("still reads project-level comments that already exist, because nothing is destroyed (CTX-15)", async () => {
    // Unwritable, still readable. A plan file is committed history, so a year of a health tracker's entries
    // must not become unopenable over a rule that arrived after they were written - the same reasoning that
    // keeps MAX_BODY off the import path and keeps `notes:` parseable forever.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    // Inserted the way the importer does, which is the only route these can arrive by now.
    await db.insert(comments).values({ projectId: p.id, itemId: null, body: "Fri 14 Aug - Day 12.", audience: "user", actor: ACTOR });

    const unattached = await listComments(db, { projectId: p.id, itemId: null });
    expect(unattached.map((c) => c.body)).toEqual(["Fri 14 Aug - Day 12."]);
    await close();
  });

  it("applies the cap on edit too, or it is one edit_comment away from decorative", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    const item = await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    const comment = await addComment(db, { projectId: p.id, body: "short enough", itemId: item.id }, ACTOR);

    await expect(editComment(db, p.id, shortCommentId(comment.id), "x".repeat(MAX_BODY + 1), ACTOR)).rejects.toThrow(/edit_item/);
    // and the original is untouched by the refused edit
    expect((await listComments(db, { projectId: p.id }))[0]?.body).toBe("short enough");
    await close();
  });

  it("filters by item and by audience, newest first", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    const item = await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    const other = await createItem(db, { projectId: p.id, area: "MCP", title: "tools" }, ACTOR);
    await addComment(db, { projectId: p.id, body: "first", itemId: other.id }, ACTOR);
    await addComment(db, { projectId: p.id, body: "about the ticket", itemId: item.id }, ACTOR);
    await addComment(db, { projectId: p.id, body: "my own working comment", itemId: other.id, audience: "agent" }, ACTOR);

    expect((await listComments(db, { projectId: p.id })).map((n) => n.body)).toEqual(["my own working comment", "about the ticket", "first"]);
    expect((await listComments(db, { projectId: p.id, itemId: item.id })).map((n) => n.body)).toEqual(["about the ticket"]);
    expect((await listComments(db, { projectId: p.id, audience: "agent" })).map((n) => n.body)).toEqual(["my own working comment"]);
    await close();
  });

  it("rejects an empty comment and an unknown audience", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    await expect(addComment(db, { projectId: p.id, body: "   " }, ACTOR)).rejects.toThrow(/needs a body/);
    // Cast: the point is to prove the runtime guard holds for a caller that is not type-checked (the MCP boundary).
    await expect(addComment(db, { projectId: p.id, body: "x", audience: "everyone" as never }, ACTOR)).rejects.toThrow(/unknown audience/);
    await close();
  });

  it("resolves a comment's ticket ref, which is what list_comments prints", async () => {
    // Comments left the context pack in CTX-4, so this is now about the listing rather than the pack: a
    // comment says which ticket it is about, and one attached to nothing says so.
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    const item = await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    await addComment(db, { projectId: p.id, body: "struggled with ser vs estar", itemId: item.id }, ACTOR);
    await legacyProjectComment(db, p.id, "unattached thought");

    const rows = await listComments(db, { projectId: p.id });
    expect(rows.map((c) => [c.body, c.itemId])).toEqual([
      ["unattached thought", null],
      ["struggled with ser vs estar", item.id],
    ]);
    await close();
  });

  it("edits and deletes by short id, keeping both in the event log", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    const target = await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    const comment = await addComment(db, { projectId: p.id, body: "preterite is the priority", itemId: target.id }, ACTOR);
    const short = comment.id.slice(-8);

    const edited = await editComment(db, p.id, short, "present perfect first, then the preterite", ACTOR);
    expect(edited.body).toBe("present perfect first, then the preterite");
    expect(edited.createdAt).toBe(comment.createdAt); // an edit does not move when the thing was observed

    await deleteComment(db, p.id, short, ACTOR);
    expect(await listComments(db, { projectId: p.id })).toEqual([]);

    // Nothing is actually lost: correcting and removing are both recoverable from the log, which is what
    // makes offering them safe at all.
    const logged = await db.select().from(events).where(eq(events.entityId, comment.id));
    expect(logged.map((e) => e.kind)).toEqual(["created", "updated", "deleted"]);
    expect(logged.at(-1)?.before).toContain("present perfect first");
    await close();
  });

  it("gives comments written back-to-back distinct short ids", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    // The regression this guards: short ids are the *tail* of the uuid, because UUIDv7 leads with a
    // millisecond timestamp. Taking the head made every comment written in the same second ambiguous, which an
    // end-to-end probe caught only because two comments a second apart both answered to `019fa928`.
    const ids = [];
    const subject = await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    for (const body of ["one", "two", "three", "four", "five"]) ids.push(shortCommentId((await addComment(db, { projectId: p.id, body, itemId: subject.id }, ACTOR)).id));
    expect(new Set(ids).size).toBe(ids.length);
    await close();
  });

  it("refuses an ambiguous or too-short comment id rather than guessing", async () => {
    const { db, ownerId, close } = await freshDb();
    const p = await project(db, ownerId);
    const subject = await createItem(db, { projectId: p.id, area: "MCP", title: "server" }, ACTOR);
    const comment = await addComment(db, { projectId: p.id, body: "one", itemId: subject.id }, ACTOR);
    // Two ids crafted to share a tail, so the ambiguity branch is genuinely exercised rather than assumed.
    for (const id of ["aaaaaaaa-0000-7000-8000-ffffffffffff", "bbbbbbbb-0000-7000-8000-ffffffffffff"]) {
      await db.insert(comments).values({ id, projectId: p.id, body: `crafted ${id}`, audience: "user", actor: ACTOR });
    }

    await expect(editComment(db, p.id, "abc", "x", ACTOR)).rejects.toThrow(/too short/);
    await expect(deleteComment(db, p.id, "0".repeat(8), ACTOR)).rejects.toThrow(/no comment with id ending/);
    await expect(deleteComment(db, p.id, "ffffffff", ACTOR)).rejects.toThrow(/matches more than one/);
    // A full id always resolves, so the same call path serves both the printed short form and a whole uuid.
    expect((await editComment(db, p.id, comment.id, "two", ACTOR)).id).toBe(comment.id);
    await close();
  });
});
