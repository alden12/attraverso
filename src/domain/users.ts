/**
 * Accounts (`OPS-4`): resolving a verified token into the row that owns things.
 *
 * The identity a token carries and the identity we own are deliberately different. A row here is keyed by an
 * id we generate, with `(issuer, subject)` and `email` as *attributes* - so `projects.owner_id` points at
 * something no provider can invalidate. See the comment on the `users` table for why neither of those is the
 * key; the short version is that a subject is issuer-scoped (a provider change would orphan every project)
 * and an email is only as trustworthy as whoever asserted it.
 *
 * `ensureUser` is the whole of the module because provisioning is just-in-time: there is no sign-up step, so
 * the first authenticated request is what creates the row.
 */
import { and, eq } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { maybeOne, one } from "../db/rows";
import { users } from "../db/schema";
import { recordEvent } from "./events";

export type User = typeof users.$inferSelect;

/**
 * What a verified credential tells us about its bearer, which is not the same thing as a `Principal` at the
 * transport boundary: that answers "is this anyone", this answers "which account".
 *
 * `emailVerified` is separate from `email` on purpose and is not a formality. It gates the account-linking
 * fallback below, and without it that fallback would let anyone who can get a provider to *assert* an address
 * take over the account holding it.
 */
export interface Identity {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified?: boolean;
}

/**
 * The single user of a file-backed store. File mode has no authentication and never will - it is one person's
 * checkout - but the domain layer must not have to ask whether a caller exists, or "is there a caller" becomes
 * a branch on every scoped query and the unauthenticated path becomes the untested one. So file mode
 * synthesises this identity instead and takes exactly the same path as a token.
 *
 * `local` is not a reserved word to any real issuer, so it cannot collide with one.
 */
export const LOCAL_IDENTITY: Identity = { issuer: "local", subject: "local" };

/**
 * The address to store, which is **only ever a verified one**.
 *
 * Making the column mean "an address some issuer vouched for" rather than "whatever the last token said" is
 * what makes the linking fallback safe by construction instead of safe by remembering to check. An unverified
 * claim is discarded rather than rejected, so someone whose provider will not vouch for their address still
 * gets in - they simply get an account of their own rather than one that already exists.
 *
 * Lower-cased because that is how it is compared, and the unique index has to agree with the lookup about what
 * counts as a duplicate.
 */
function verifiedEmail(identity: Identity): string | null {
  if (identity.emailVerified !== true) return null;
  const email = identity.email?.trim().toLowerCase();
  return email === undefined || email === "" ? null : email;
}

/**
 * The row for this identity, created on first sight.
 *
 * Three steps, and the middle one is the whole point:
 *
 * 1. **By `(issuer, subject)`** - the normal path, every request after the first. Exact, cheap, and immune to
 *    anything an email claim might be lying about.
 * 2. **By verified email**, when step 1 misses: bind this new subject onto the existing row and carry on. This
 *    is what makes changing auth provider self-healing - each person's first login afterwards re-binds their
 *    own row - rather than a hand-written remap against a table of orphans. Only a *verified* address is ever
 *    stored (see `verifiedEmail`), so this step cannot match on one nobody vouched for - which is the
 *    difference between account linking and account takeover.
 * 3. **Create**, when neither matched.
 *
 * All three run in one transaction, so two concurrent first requests from the same person cannot produce two
 * rows - the unique indexes decide, and the loser's insert fails rather than silently duplicating an account.
 *
 * Only steps 2 and 3 write an event. Step 1 is the common case and logging it would append a row per request,
 * drowning the log it is supposed to make readable; a linking or a creation is exactly the rare, consequential
 * thing an audit trail is for.
 */
export async function ensureUser(db: Database, identity: Identity): Promise<User> {
  return db.transaction((tx) => ensureUserIn(tx, identity));
}

/**
 * The same thing for a caller already inside a transaction - the YAML importer, which must stamp the local
 * owner onto every project it inserts and cannot open a nested one.
 */
export async function ensureUserIn(tx: Tx, identity: Identity): Promise<User> {
  const email = verifiedEmail(identity);
  {
    const bySubject = maybeOne(
      await tx
        .select()
        .from(users)
        .where(and(eq(users.issuer, identity.issuer), eq(users.subject, identity.subject))),
    );
    if (bySubject !== null) return refreshEmail(tx, bySubject, email);

    if (email !== null) {
      const byEmail = maybeOne(await tx.select().from(users).where(eq(users.email, email)));
      if (byEmail !== null) {
        const linked = one(
          await tx
            .update(users)
            .set({ issuer: identity.issuer, subject: identity.subject })
            .where(eq(users.id, byEmail.id))
            .returning(),
        );
        await recordEvent(tx, {
          projectId: null,
          entityType: "user",
          entityId: linked.id,
          kind: "linked",
          actor: linked.id,
          before: byEmail,
          after: linked,
        });
        return linked;
      }
    }

    const created = one(
      await tx.insert(users).values({ issuer: identity.issuer, subject: identity.subject, email }).returning(),
    );
    await recordEvent(tx, {
      projectId: null,
      entityType: "user",
      entityId: created.id,
      kind: "created",
      // The new user is the actor in their own creation. Circular but honest: nobody else asked for this row.
      actor: created.id,
      after: created,
    });
    return created;
  }
}

/**
 * Keep a stored address in step with the token's, on the ordinary path.
 *
 * Not cosmetic: `email` is what the account-linking fallback matches on, so a stale one would send someone to
 * the wrong row after a provider switch - the exact failure the fallback exists to prevent. Silent, and no
 * event: it is a correction to a cached attribute, not a decision anyone made.
 *
 * A token with no email - or with an unverified one - never clears a stored address. What we once verified is
 * better evidence than what this particular token happens to omit or decline to vouch for.
 *
 * **And it gives up rather than failing when another row already holds the address.** Reachable when someone
 * signs in before their provider verifies them and a second account already has the verified address: this
 * caller has already resolved correctly by `(issuer, subject)`, so the address is an anchor they happen to
 * lack, not their identity - and a login is the wrong place to raise a conflict nobody can act on. The other
 * row keeps it, which is right, because it is the one that proved the address first.
 *
 * A `SELECT` rather than catching the unique violation, deliberately: in Postgres a failed statement aborts
 * the whole transaction, so "try it and recover" would leave the caller with a dead transaction rather than a
 * user. The check and the update are in one transaction either way, so the race just re-runs on the next call.
 */
async function refreshEmail(tx: Tx, user: User, email: string | null): Promise<User> {
  if (email === null || email === user.email) return user;
  const taken = maybeOne(await tx.select({ id: users.id }).from(users).where(eq(users.email, email)));
  if (taken !== null) return user;
  return one(await tx.update(users).set({ email }).where(eq(users.id, user.id)).returning());
}
