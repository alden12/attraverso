/**
 * Projects (PROJ-1): identity and the running direction. One database holds all of a person's projects, so
 * "what am I working on across everything?" is a query. Every mutation writes an event in the same
 * transaction (DATA-4).
 *
 * `type` is an open string ("software" | "learning" | ...), validated nowhere here on purpose: a new project
 * type must never be a migration or a code change to this file.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { timestamp } from "../db/ids";
import { one, maybeOne } from "../db/rows";
import { projects } from "../db/schema";
import { setSection, PROTOCOL_HEADING } from "./context";
import { mutate, type Actor } from "./events";
import type { OwnedProject, OwnedProjectId, Project } from "./owned";

export type { OwnedProject, OwnedProjectId, Project } from "./owned";

/**
 * The only place an `OwnedProjectId` is minted (`DATA-16`), and it sits here because every caller of it is a
 * line or two below an ownership check. A reviewer asking "is this scoping sound?" has one function to read.
 */
const owned = (project: Project): OwnedProject => project as OwnedProject;

export interface NewProject {
  key: string;
  name: string;
  type: string;
  direction?: string;
  /** The `users` row that will own it (OPS-4). Stamped at creation and never edited afterwards. */
  ownerId: string;
}

/**
 * The default `protocol` a new project starts with (CTX-9): the session-operating instructions as data,
 * surfaced first by `get_project` and applied before acting. It is an ordinary revisable section, so a
 * project elaborates or rewrites it over time (a learning project's protocol is its session methodology, not
 * this tool-hygiene note).
 *
 * **Every word here is re-read at the top of every session, forever**, so this text is kept to what an agent
 * cannot get anywhere else. Two things are therefore deliberately absent, both of which used to be here:
 *
 * - **A tool inventory.** MCP already hands the model every tool name, description and input schema. Listing
 *   them again, and describing the entity shapes those schemas already define, spent context restating what
 *   the client had already supplied.
 * - **Anything assuming a software repo.** It described itself as a project-scoped `CLAUDE.md`, explained
 *   this codebase's own schema rationale ("no type column, since a schedule is an optional attachment"), and
 *   closed with a warning about hand-editing the YAML while a server runs. All meaningless to someone
 *   learning a language from a home-dir store, who will never open that file - and it is the *default*, so it
 *   was shipping this repo's assumptions into every project of any kind.
 *
 * What survives is what the model cannot infer: that this section is the thing to read first and to revise,
 * a placeholder for the project's own session shape, and the write-as-you-go instruction - which is a
 * behavioural default, not a fact about the API, and is the one thing that stops a session leaving no record.
 *
 * The closing "not filled in yet" block is the onboarding interview, and it is written to delete itself once
 * used. That is deliberate: setup guidance is relevant exactly once, but the protocol is re-read at the top of
 * every session, so leaving it in place would mean permanently spending context on instructions that no longer
 * apply. It lives here rather than only in the `create_project` tool description so that a project seeded by an
 * import or a script still knows it is unfinished and what to ask.
 *
 * There is deliberately no per-type variant of this text. Branching the default on "software" vs "learning"
 * would put a domain noun in the domain layer, which is the one thing the model forbids; the interview adapts
 * because an agent conducts it, not because a switch statement does.
 */
export const DEFAULT_PROTOCOL = {
  heading: PROTOCOL_HEADING,
  content: `This is the project's protocol: the first thing a session reads, and where to keep how this project should be run. Apply it before acting, and revise it with set_context as you learn - the next session inherits whatever is here, and nothing else carries over. Markdown, as are item bodies and context sections.

**Overview.** What this project is and where it is going - fill this in.

**Running a session.** Open with get_project, which returns this protocol first and can be called again any time you lose track of where things stand. Describe here how a session should actually go for this project: how to open, and what to ask.

**Write as you go. Do not save it for the end - there is no end.** A conversation gets abandoned rather than closed, so anything held back for a final write is lost. Use add_comment whenever something is worth having next time: what the user struggled with or asked, a decision made in passing, what to pick up next. One line, no reading first, cheap enough mid-task. Little and often beats a tidy summary that never gets written. Correct one with edit_comment or drop it with delete_comment if it turns out to be wrong.

**Not filled in yet.** Nothing above is specific to this project - this is still the stock protocol. Interview the user, write each answer back as you get it rather than saving them all to the end, then remove this section with set_context so it is not re-read every session:
- What is this project, and what does a good outcome look like? -> set_direction, and the Overview above.
- What are the first things to get through, and how do they group? -> create_item for each; the ref prefix is the grouping, so pick it deliberately.
- How should a session open and close? -> Running a session above.
- What must I always know, or always avoid, here? Conventions, constraints, decisions already made. -> its own context section, via set_context.
- Is anything recurring rather than one-off (practice, upkeep, review)? -> say so on those items; scheduling attaches to them later.
Ask a couple at a time and infer what you reasonably can rather than interrogating; a thin protocol that gets used beats a thorough one that stalls the first session.`,
} as const;

export async function createProject(db: Database, input: NewProject, actor: Actor): Promise<OwnedProject> {
  return mutate(db, actor, async (tx) => {
    // Friendly check before the unique constraint fires, so the error names the collision. Scoped to the owner
    // for the same reason the index is (OPS-4): unscoped, this would tell the caller that *someone* holds the
    // key, which is a disclosure dressed as a validation message.
    const existing = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.ownerId, input.ownerId), eq(projects.key, input.key)));
    if (existing.length > 0) throw new Error(`a project with key "${input.key}" already exists`);

    const project = one(
      await tx
        .insert(projects)
        .values({
          key: input.key,
          ownerId: input.ownerId,
          name: input.name,
          type: input.type,
          direction: input.direction ?? null,
          status: "active",
        })
        .returning(),
    );
    // Minted here because the row was created *with* this owner - the strongest form the check can take.
    const result = owned(project);
    return { result, event: { projectId: result.id, entityType: "project", entityId: result.id, kind: "created", after: project } };
  });
}

/**
 * Create a project and seed its default `protocol` section. This is the path a user or agent takes when
 * creating a project through the tool, so a fresh project is never blank - it opens already knowing how to run
 * a session and to edit itself through the tools. Kept separate from `createProject` (a pure single-mutation
 * primitive) and composed from two `mutate` calls, per the one-event-per-mutation rule; the primitive stays
 * available for tests and any path that wants a project with no defaults.
 */
export async function createProjectWithDefaults(db: Database, input: NewProject, actor: Actor): Promise<OwnedProject> {
  const project = await createProject(db, input, actor);
  await setSection(db, { projectId: project.id, heading: DEFAULT_PROTOCOL.heading, content: DEFAULT_PROTOCOL.content }, actor);
  return project;
}

/**
 * The caller's projects, and only theirs (OPS-4).
 *
 * `ownerId` is required rather than optional-meaning-all: an unowned project matches no owner and so is
 * visible to nobody, which is the direction this has to fail in while the deployed database is being
 * backfilled. An optional parameter would make "show me everything" the *default* and one forgotten argument
 * away, which is precisely the leak.
 */
export async function listProjects(db: Database, ownerId: string): Promise<OwnedProject[]> {
  return (await db.select().from(projects).where(eq(projects.ownerId, ownerId)).orderBy(asc(projects.createdAt))).map(owned);
}

/**
 * Look a project up by the handle its owner knows it by. Keys are unique per owner, not globally, so the
 * owner is half the identifier rather than a filter applied afterwards - and a key belonging to someone else
 * is indistinguishable here from one that does not exist, which is the answer a caller should get.
 */
export async function getProjectByKey(db: Database, ownerId: string, key: string): Promise<OwnedProject | null> {
  const project = maybeOne(
    await db.select().from(projects).where(and(eq(projects.ownerId, ownerId), eq(projects.key, key))),
  );
  return project === null ? null : owned(project);
}

/** Revise the running north-star statement, versioned through the event log rather than edited silently. */
export async function setDirection(db: Database, projectId: OwnedProjectId, direction: string, actor: Actor): Promise<OwnedProject> {
  return mutate(db, actor, async (tx) => {
    const before = maybeOne(await tx.select().from(projects).where(eq(projects.id, projectId)));
    if (before === null) throw new Error("no such project");
    const after = owned(
      one(await tx.update(projects).set({ direction, updatedAt: timestamp() }).where(eq(projects.id, projectId)).returning()),
    );
    return { result: after, event: { projectId, entityType: "project", entityId: projectId, kind: "direction-changed", before, after } };
  });
}
