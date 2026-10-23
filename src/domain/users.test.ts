/**
 * Accounts and per-owner scoping (`OPS-4`).
 *
 * Two things are being proved here, and the second is the one that matters. That `ensureUser` resolves the
 * same person to the same row across a change of provider - and that it refuses to when the only evidence is
 * an address nobody verified. And that a project belonging to one account is not merely filtered out of
 * another's listing but *unreachable* from it, including through the key it is named by.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb } from "../db/testing";
import { events, projects } from "../db/schema";
import { createProject, getProjectByKey, listProjects } from "./projects";
import { ensureUser, LOCAL_IDENTITY, type Identity } from "./users";

const ACTOR = "test";
const ALICE: Identity = { issuer: "https://idp.example/auth/v1", subject: "sub-alice", email: "alice@example.com", emailVerified: true };
const BOB: Identity = { issuer: "https://idp.example/auth/v1", subject: "sub-bob", email: "bob@example.com", emailVerified: true };

describe("ensureUser", () => {
  it("creates a row on first sight and returns the same one afterwards", async () => {
    const { db, close } = await freshDb();
    const first = await ensureUser(db, ALICE);
    const again = await ensureUser(db, ALICE);
    expect(again.id).toBe(first.id);
    expect(await db.select().from(projects)).toHaveLength(0);
    expect(first.email).toBe("alice@example.com");
    await close();
  });

  it("stores and matches the email case-insensitively", async () => {
    const { db, close } = await freshDb();
    const created = await ensureUser(db, { ...ALICE, email: "Alice@Example.COM" });
    // Stored the way it is compared, or the unique index and the lookup would disagree about what a duplicate is.
    expect(created.email).toBe("alice@example.com");
    await close();
  });

  it("links the same person across a change of provider, keeping their id", async () => {
    const { db, close } = await freshDb();
    const before = await ensureUser(db, ALICE);
    const project = await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId: before.id }, ACTOR);

    // The whole point: a new issuer and a new subject, the same verified address. This is what a migration to
    // another auth provider looks like from the server's side - nobody runs a remap, each person's next login rebinds.
    const after = await ensureUser(db, { issuer: "https://other.example/auth/v1", subject: "sub-new", email: "alice@example.com", emailVerified: true });
    expect(after.id).toBe(before.id);
    expect(after.issuer).toBe("https://other.example/auth/v1");
    expect(after.subject).toBe("sub-new");
    // And the project came with them, because `owner_id` never pointed at anything the provider controls.
    expect((await listProjects(db, after.id)).map((p) => p.id)).toEqual([project.id]);
    await close();
  });

  it("refuses to link on an unverified email, giving that caller an account of their own", async () => {
    const { db, close } = await freshDb();
    const alice = await ensureUser(db, ALICE);
    await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId: alice.id }, ACTOR);

    // The takeover attempt: a provider that will assert any address you type. Without the verification gate
    // this returns Alice's row and hands over her projects.
    const imposter = await ensureUser(db, {
      issuer: "https://idp.example/auth/v1",
      subject: "sub-imposter",
      email: "alice@example.com",
      emailVerified: false,
    });

    expect(imposter.id).not.toBe(alice.id);
    // The claim is discarded rather than stored, so it cannot collide with Alice's row or be linked to later.
    expect(imposter.email).toBeNull();
    expect(await listProjects(db, imposter.id)).toEqual([]);
    expect((await listProjects(db, alice.id)).map((p) => p.key)).toEqual(["apm"]);
    await close();
  });

  it("stores nothing for an unverified address, so it can never be linked to", async () => {
    const { db, close } = await freshDb();
    const created = await ensureUser(db, { issuer: "https://idp.example/auth/v1", subject: "sub-x", email: "x@example.com", emailVerified: false });
    expect(created.email).toBeNull();
    // Two unattributed accounts do not collide: nulls are distinct in a Postgres unique index.
    const second = await ensureUser(db, { issuer: "https://idp.example/auth/v1", subject: "sub-y", email: "x@example.com", emailVerified: false });
    expect(second.id).not.toBe(created.id);
    await close();
  });

  it("does not fail a login when another account already holds the verified address", async () => {
    const { db, close } = await freshDb();
    const alice = await ensureUser(db, ALICE);
    // Signed in before their provider would vouch for them, so this row stored no address.
    const other = await ensureUser(db, { issuer: ALICE.issuer, subject: "sub-other", email: "alice@example.com", emailVerified: false });
    expect(other.email).toBeNull();

    // Now verified. The row still resolves by (issuer, subject) - the address is an anchor it lacks, not its
    // identity - so the update yields instead of hitting the unique index and killing the transaction.
    const again = await ensureUser(db, { issuer: ALICE.issuer, subject: "sub-other", email: "alice@example.com", emailVerified: true });
    expect(again.id).toBe(other.id);
    expect(again.email).toBeNull();
    // The account that proved the address first keeps it, and keeps its projects.
    expect((await ensureUser(db, ALICE)).email).toBe("alice@example.com");
    expect(alice.id).not.toBe(other.id);
    await close();
  });

  /**
   * The ordering question worth being sure about: an attacker who claims someone's address unverified, and
   * gets in first. The claim is *discarded*, so their row holds nothing for step 2 to match on - which is why
   * discarding is stronger here than rejecting would have been.
   */
  it("does not hand a real user the account of someone who claimed their address unverified", async () => {
    const { db, close } = await freshDb();
    const attacker = await ensureUser(db, { issuer: ALICE.issuer, subject: "sub-attacker", email: "alice@example.com", emailVerified: false });
    await createProject(db, { key: "trap", name: "Trap", type: "software", ownerId: attacker.id }, ACTOR);

    const alice = await ensureUser(db, ALICE);
    expect(alice.id).not.toBe(attacker.id);
    expect(await listProjects(db, alice.id)).toEqual([]);
    await close();
  });

  it("keeps a stored address when a later token omits the claim", async () => {
    const { db, close } = await freshDb();
    const created = await ensureUser(db, ALICE);
    const seen = await ensureUser(db, { issuer: ALICE.issuer, subject: ALICE.subject });
    // An address we once verified is better evidence than a claim this particular token happens to leave out -
    // and clearing it would quietly disarm the linking fallback.
    expect(seen.id).toBe(created.id);
    expect(seen.email).toBe("alice@example.com");
    await close();
  });

  it("logs a creation and a linking, but not an ordinary sign-in", async () => {
    const { db, close } = await freshDb();
    const user = await ensureUser(db, ALICE);
    await ensureUser(db, ALICE);
    await ensureUser(db, ALICE);
    await ensureUser(db, { issuer: "https://other.example/auth/v1", subject: "sub-new", email: "alice@example.com", emailVerified: true });

    const rows = await db.select().from(events).where(eq(events.entityId, user.id));
    // Three sign-ins and one link: an event per request would drown the log it is meant to make readable.
    expect(rows.map((r) => r.kind)).toEqual(["created", "linked"]);
    await close();
  });

  it("gives the local identity an ordinary account, so file mode has no special path", async () => {
    const { db, ownerId, close } = await freshDb();
    const local = await ensureUser(db, LOCAL_IDENTITY);
    expect(local.id).toBe(ownerId); // the fixture provisioned exactly this one
    expect(local.email).toBeNull();
    await close();
  });
});

describe("project scoping (OPS-4)", () => {
  it("lets two owners hold the same key, and keeps each listing to its own", async () => {
    const { db, close } = await freshDb();
    const alice = await ensureUser(db, ALICE);
    const bob = await ensureUser(db, BOB);

    // Globally unique keys made this a constraint violation, which told the second person that someone else
    // had the name - a disclosure dressed as a validation message.
    await createProject(db, { key: "apm", name: "Alice's", type: "software", ownerId: alice.id }, ACTOR);
    await createProject(db, { key: "apm", name: "Bob's", type: "software", ownerId: bob.id }, ACTOR);

    expect((await listProjects(db, alice.id)).map((p) => p.name)).toEqual(["Alice's"]);
    expect((await listProjects(db, bob.id)).map((p) => p.name)).toEqual(["Bob's"]);
    await close();
  });

  it("still refuses a duplicate key within one owner, and says so plainly", async () => {
    const { db, close } = await freshDb();
    const alice = await ensureUser(db, ALICE);
    await createProject(db, { key: "apm", name: "AI PM", type: "software", ownerId: alice.id }, ACTOR);
    await expect(
      createProject(db, { key: "apm", name: "again", type: "software", ownerId: alice.id }, ACTOR),
    ).rejects.toThrow(/already exists/);
    await close();
  });

  it("makes another owner's project indistinguishable from one that does not exist", async () => {
    const { db, close } = await freshDb();
    const alice = await ensureUser(db, ALICE);
    const bob = await ensureUser(db, BOB);
    await createProject(db, { key: "secret", name: "Alice's", type: "software", ownerId: alice.id }, ACTOR);

    // Not "forbidden", which would confirm it is there. Null, exactly as for a key nobody has ever used.
    expect(await getProjectByKey(db, bob.id, "secret")).toBeNull();
    expect(await getProjectByKey(db, bob.id, "never-existed")).toBeNull();
    await close();
  });

  /**
   * There is no "unowned" state to test: `owner_id` is NOT NULL, so the database refuses the row rather than
   * accepting one that no scoped query could ever reach. The stronger version of what a test could assert.
   */
  it("refuses a project with no owner at all", async () => {
    const { db, close } = await freshDb();
    await expect(db.insert(projects).values({ key: "orphan", name: "Orphan", type: "software", status: "active" } as never)).rejects.toThrow();
    await close();
  });
});
