/**
 * The database schema, defined once in Drizzle's `pg-core`. This single definition drives both the DDL
 * (drizzle-kit generates the migrations from it) and the row types the domain layer reads, and it runs
 * unchanged on in-memory PGlite locally and server Postgres in the cloud - the two are the same engine.
 *
 * This is the model from the project's design, not a fresh one: `items` carries tickets, skills and care
 * items in one table with no type or lifecycle column (everything closes, so the only thing that varies is
 * whether an item has a schedule, which is a future nullable attachment). `projects.type`, `items.status`
 * and `events.entity_type` are deliberately open sets with no CHECK/enum: a new kind is a row, never a
 * migration. The domain layer validates the status vocabulary and legal transitions.
 *
 * Timestamps are `text`, not `timestamptz`, on purpose: they are generated in the application as
 * fixed-width ISO-8601 UTC (see `ids.ts`), which orders correctly as text and - crucially for the
 * YAML-as-source-of-truth model - round-trips verbatim, where a `timestamptz` would re-format on the way
 * out and turn every export into a whole-file diff.
 */
import { sql } from "drizzle-orm";
import { pgTable, text, integer, doublePrecision, index, uniqueIndex, primaryKey, foreignKey, check, customType } from "drizzle-orm/pg-core";
import { uuidv7, timestamp } from "./ids";

/**
 * The text-search configuration every index and every query uses (`DATA-11`).
 *
 * **Hardcoded, and known debt.** It is right for this project and wrong for a Spanish one: the configuration
 * decides stemming and stop words, so `'english'` applied to Spanish text stems nothing and strips the wrong
 * words. The eventual shape is a `text_search_config` on `projects` defaulting to this, which is deliberately
 * not built yet - a generated column cannot depend on another table's value, so per-project configuration
 * means either a trigger-maintained column or one index per configuration, and that is a decision to make
 * against a real second-language project rather than in advance of one.
 *
 * It lives here as one constant so that switch is a single edit rather than a hunt across four generated
 * columns and every query. Changing it *is* a schema change: the stored vectors are part of the column
 * definition and have to be rebuilt. Free locally, where PGlite is rebuilt from the YAML on every load.
 */
export const TEXT_SEARCH_CONFIG = "english";

/**
 * Postgres `tsvector`. Drizzle has no built-in for it, and this is only ever read back as an opaque string -
 * the ranking and the snippets are computed in SQL, so nothing in the domain layer parses one.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

/**
 * The indexed form of a row: its text columns, stemmed and weighted.
 *
 * `A` outranks `B`, which is what makes a title match beat a body match for the same term. `coalesce` because
 * a null column would otherwise null the whole concatenation and silently drop the row out of the index.
 *
 * Built as raw DDL because it is only ever a column definition. **Postgres maintains it inside the same write
 * as the row**, so it cannot drift and there is no trigger and no domain-layer bookkeeping to keep in step -
 * which is the entire reason for preferring this over a separate index table (`DATA-11`).
 */
const searchVector = (...parts: [column: string, weight: "A" | "B"][]) =>
  sql.raw(
    parts
      .map(([column, weight]) => `setweight(to_tsvector('${TEXT_SEARCH_CONFIG}', coalesce("${column}", '')), '${weight}')`)
      .join(" || "),
  );

/**
 * Who owns a project (`OPS-4`), keyed by an id we generate and never by the identity provider's subject.
 *
 * `subject` is scoped to its issuer, so owning on it directly would orphan every project the day the auth
 * provider changed - and a provider's `sub` is usually its own user uuid, so merely recreating the auth
 * project would do it. Keying on `email` instead trades that for a worse problem: an email claim is only as
 * trustworthy as the provider asserting it, and re-enabling password sign-in is a dashboard toggle, after
 * which someone could register an address they do not own and inherit its projects. So both are attributes
 * of a row identified by neither, and `ensureUser` resolves by `(issuer, subject)` first, falling back to a
 * **verified** email and re-binding the new subject onto the existing row. That fallback is what makes a
 * provider switch self-healing rather than a hand-written remap; the `email_verified` gate on it is
 * load-bearing, because without it the fallback is the same hazard wearing a hat.
 *
 * `issuer` is stored rather than assumed: a subject is only unique within the issuer that minted it, and
 * "which provider was this from" is precisely the question a provider switch asks.
 *
 * **Deliberately not serialised to YAML.** Identity belongs to a deployment, not to a plan: a committed
 * `roadmap.apm.yaml` that recorded its owner would have a clone import the committer's account. File mode
 * synthesises one local user instead (`issuer: "local"`), so the domain layer never has to ask whether a
 * caller exists.
 */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    issuer: text("issuer").notNull(), // the token's `iss`, or "local" in file mode
    subject: text("subject").notNull(), // the token's `sub`, or "local" in file mode
    email: text("email"), // nullable: a provider may omit the claim, and the local user has none
    createdAt: text("created_at").notNull().$defaultFn(timestamp),
  },
  (t) => [
    uniqueIndex("users_issuer_subject").on(t.issuer, t.subject),
    // Unique so the email fallback can never face two candidate rows - the one ambiguity account linking
    // must not have. Nulls are distinct in Postgres, so unattributed users do not collide with each other.
    uniqueIndex("users_email").on(t.email),
  ],
);

/**
 * Who may use this deployment at all (`OPS-4`), as distinct from `users`, which is who *has*.
 *
 * A table rather than `APM_ALLOWED_EMAILS`, because an access list that only changes by editing a secret
 * changes rarely and at the wrong moments: every edit is a machine restart, it cannot be done from a phone,
 * and it is invisible to every test. This can be read per request, edited from a console or eventually a tool
 * call, and covered by the migration and event machinery like anything else.
 *
 * **An empty table means nobody**, deliberately - the opposite of the env var it replaces, where unset meant
 * *everyone*. The difference between a list that is off and a list that is empty is exactly the failure this
 * project lived through on 2026-08-31, when an uninvited account reached a server whose only gate was unset.
 *
 * Keyed on the address itself: it is the thing a person is invited by, it is what arrives in a token, and a
 * primary key means a `INSERT` from a console cannot quietly create a duplicate that only one query finds.
 * Stored lower-cased, matching how `verifiedEmail` normalises before comparing.
 */
export const allowedEmails = pgTable("allowed_emails", {
  email: text("email").primaryKey(), // lower-cased; see `isEmailAllowed`
  note: text("note"), // who this is, so a bare list of addresses is still readable in a year
  /**
   * The one column in this schema with a **database** default as well as an application one, and the exception
   * is narrow enough to state exactly.
   *
   * Timestamps are generated in the application everywhere else so they round-trip verbatim into the plan YAML
   * - a `timestamptz` would re-format on the way out and turn every export into a whole-file diff. This table
   * is not serialised at all (it is who may reach a *deployment*, not part of a plan), so that reason does not
   * reach it, and its absence has a cost the others do not have: inviting someone is meant to be one `INSERT`
   * typed into a console from a phone, and a `NOT NULL` column with no default makes that three fields.
   *
   * The expression reproduces `Date.toISOString()` exactly - `YYYY-MM-DDTHH:MM:SS.mmmZ`, three-digit
   * milliseconds, UTC - so a row written by hand is indistinguishable from one written by `allowEmail`.
   */
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(timestamp)
    .default(sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`),
});

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    key: text("key").notNull(), // short human handle, e.g. "apm" or "spanish"
    // NOT NULL from the start (`OPS-4`). The first plan had it nullable with a backfill behind it, which the
    // deployed database made unnecessary: it held one throwaway smoke project, deleted rather than migrated.
    // Worth taking, because an unowned row is a row no scoped query can reach - it would sit there invisible
    // rather than failing loudly, and a constraint says that better than a test can.
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    type: text("type").notNull(), // "software" | "learning" | ... deliberately open
    direction: text("direction"), // the running north star; revised in place, history via events
    status: text("status").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(timestamp),
    updatedAt: text("updated_at").notNull().$defaultFn(timestamp),
    archivedAt: text("archived_at"),
  },
  (t) => [
    // Per owner, not global. A globally unique key was right while one database held one person's projects
    // and is a cross-tenant disclosure once it is shared: the second person to create a project keyed "apm"
    // would be told the name was taken, which reveals that someone else has one. Same shape as the
    // project-scoped uniqueness on `areas`, `items` and `context_sections`; ownership adds one level above.
    uniqueIndex("projects_owner_key").on(t.ownerId, t.key),
  ],
);

export const areas = pgTable(
  "areas",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // the item ref prefix, e.g. "DATA"
    name: text("name").notNull(),
    description: text("description"),
    colour: text("colour"), // stable hue, so the viewer stops assigning by first-seen order
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(timestamp),
  },
  (t) => [uniqueIndex("areas_project_key").on(t.projectId, t.key)],
);

// Everything you act on: tickets, and later skills and care items. No type or lifecycle column - see the
// file header. An item with no schedule (a future attachment) is what we have always called a ticket.
export const items = pgTable(
  "items",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7), // stable even if the ref is renamed
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ref: text("ref").notNull(), // the human id: "DATA-5", "DATA-5.1"
    areaKey: text("area_key").notNull(), // the ref prefix, denormalised so filtering by area is one table
    sortPath: text("sort_path").notNull(), // zero-padded numerics so text order = numeric order
    parentId: text("parent_id"), // derived from the ref, never set independently; self-FK below
    title: text("title").notNull(),
    body: text("body"), // a markdown block (the viewer renders it; the MCP write tools say so)
    status: text("status").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(timestamp),
    updatedAt: text("updated_at").notNull().$defaultFn(timestamp),
    closedAt: text("closed_at"),
    deletedAt: text("deleted_at"), // soft delete; there is no hard-delete path
    // Planned dates (`CAL-1`), both optional and hand-set. A calendar day (`2026-11-02`), not a timestamp: a
    // due date stored as UTC midnight lands on the previous day for anyone west of Greenwich, so `_on` here
    // where every instant above is `_at`. Distinct from the scheduling layer's computed `due_at`, which a
    // recompute owns; this one is a stated intention and nothing overwrites it.
    startOn: text("start_on"),
    dueOn: text("due_on"),
    // Full-text search (DATA-11). Maintained by Postgres inside the same write, never by us.
    tsv: tsvector("tsv").generatedAlwaysAs(() => searchVector(["title", "A"], ["body", "B"])),
  },
  (t) => [
    uniqueIndex("items_project_ref").on(t.projectId, t.ref),
    // Self-reference via the table-extras form rather than inline, which keeps the column's type simple.
    foreignKey({ columns: [t.parentId], foreignColumns: [t.id] }).onDelete("cascade"),
    index("items_project_status").on(t.projectId, t.status),
    index("items_project_area").on(t.projectId, t.areaKey),
    index("items_project_sort").on(t.projectId, t.sortPath),
    index("items_parent").on(t.parentId),
    // A calendar asks for a window of days, which this answers without reading the plan.
    index("items_project_due").on(t.projectId, t.dueOn),
    index("items_tsv").using("gin", t.tsv),
  ],
);

// Directed: `dependsOnId` must be done before `itemId` can start.
export const dependencies = pgTable(
  "dependencies",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    dependsOnId: text("depends_on_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().$defaultFn(timestamp),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.dependsOnId] }), index("dependencies_depends_on").on(t.dependsOnId)],
);

/**
 * A dependency that names another project: `apm-cloud:OPS-1` depends on `apm:DIST-1` (`PROJ-11`).
 *
 * **A separate table because the target is text, not a row.** Once a plan spans several store files
 * (`IMP-17`) an edge can point into a project that is not loaded - a clone of the public repo has one store
 * by construction - and there is no id to reference. Widening `dependencies` with a nullable
 * `depends_on_id` would make every existing query on it filter for the real rows; a second table leaves all
 * of them correct untouched.
 *
 * **Every scoped dependency lives here, including the ones that currently resolve.** The tempting
 * optimisation is to store a resolvable one as an ordinary `dependencies` row, but then the same YAML builds
 * a different database depending on which *other* file happened to be loaded, and the export stops round
 * -tripping. Resolution is a read-time join, never a storage decision.
 *
 * A scope naming the item's own project is normalised away on write, so there is exactly one representation
 * of a within-project edge and `dependencies` stays the whole of the graph that cycles and blocking run over.
 */
export const scopedDependencies = pgTable(
  "scoped_dependencies",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    /** The other project's key, as written. Not a foreign key: the point of the row is that the project it
     *  names may not be loaded, and a constraint would make the unresolved case unstorable. */
    targetProject: text("target_project").notNull(),
    targetRef: text("target_ref").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(timestamp),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.targetProject, t.targetRef] })],
);

/**
 * A numeric or categorical reading, taken at a time (`METRIC-1`).
 *
 * The primitive the memory layer lacked: `observations` hold durable revisable *facts*, and forcing a weight
 * or a rep count into prose loses the ability to trend it. `CTX-15` found a live health-tracking project
 * hand-rolling exactly this as ~750-character daily comments, which is what brought the work forward.
 *
 * **These rows do not live in the plan file.** Every other table here is low-volatility, and the whole of
 * `roadmap.apm.yaml` is rewritten on each change - affordable at tens of kilobytes. Measurements break both
 * properties: append-heavy by nature (a daily weigh-in, a meal, every set of every lift) and larger in a year
 * than the plan they hang off. They follow `IMP-7`'s split-by-volatility rule to
 * `.apm/measurements/YYYY-MM.yaml`, appended rather than rewritten (`METRIC-2` implements that; `IMP-8`'s
 * coverage manifest already records where they go).
 *
 * **Placement resolves at the root.** A root row carries its subject - `item_id` for a reading about an item
 * ("this lift's working weight"), null for one about the project ("body weight", "daily calories"), following
 * the nullable-FK precedent `attachments` set. A child carries `parent_id` and *inherits* placement, with
 * `item_id` denormalised onto it. That is stored derived state, which this model normally refuses, and it is
 * the same exception `due_at` is: aggregation is the hot path, and it is safe only because the call that
 * writes a tree writes it, and nothing hand-edits it.
 *
 * **Measurements nest, exactly as items do.** A workout is one occurrence holding `bench_press_weight` and
 * `bench_press_reps`; a meal holds `kcal` and `protein_g`. One nesting idea in the product rather than two.
 * Depth is uncapped, matching items, because any cap would be arbitrary - and it is safe to allow because
 * **aggregation never traverses the tree**: "all calories on 14 Aug" is `metric` and `at`, whichever shape the
 * rows were written in. A badly shaped tree costs display quality, never correctness.
 *
 * A parent node with no reading is an **occurrence** - it happened, at a time - which is what this table is
 * for. A *definition* ("sleep_duration is measured in hours") is undated, revisable and one per name, so it
 * belongs in the plan file beside `areas` if it is ever needed, never among the readings.
 */
export const measurements = pgTable(
  "measurements",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The subject, and null means the project itself. Denormalised onto children from their root.
    itemId: text("item_id").references(() => items.id, { onDelete: "cascade" }),
    parentId: text("parent_id"), // self-FK below, as `items` does it
    // What was measured: "kcal", "body_weight", "sleep_quality". The vocabulary is discovered with
    // SELECT DISTINCT rather than maintained as an enum, so it cannot drift out of step with the data.
    metric: text("metric").notNull(),
    /**
     * The reading, when it is a number.
     *
     * `double precision` rather than `numeric`: it maps to a JS number, where Postgres `numeric` comes back
     * as a string that every consumer has to parse, buying an exactness nobody logging a body weight needs.
     * Integers stay exact to 2^53, which covers every count this will hold.
     */
    value: doublePrecision("value"),
    /**
     * The reading, when it is categorical ("restless"). A separate column rather than widening `value` to
     * text, because a text column cannot be SUMmed, AVGed or ordered without a cast on every query - and the
     * moment one row holds "restless" the whole series stops trending.
     */
    textValue: text("text_value"),
    // Per row, deliberately: a series may honestly hold both kg and lb. Normalising is the job of whatever
    // trends or plots it (METRIC-4 must refuse a mixed axis); this table's job is not to lose what was written.
    unit: text("unit"),
    /**
     * Display metadata, and it must stay that way: the human-readable name of what a reading is of
     * ("overnight oats"). **Never aggregated** - the test is that wanting `GROUP BY label` means it should
     * have been a node. `CTX-2` measured what happens when the cheap path beats the correct one (`add_note`
     * ignored 64 times out of 64), so writing a tree has to be as cheap as labelling at the tool boundary.
     */
    label: text("label"),
    at: text("at").notNull(), // when it was measured, not when it was recorded - see `createdAt`
    source: text("source"), // how it was arrived at: "labelled", "estimated", "scale"
    actor: text("actor").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(timestamp),
  },
  (t) => [
    foreignKey({ columns: [t.parentId], foreignColumns: [t.id] }).onDelete("cascade"),
    // The trending query, and the aggregate one: both are (project, metric, window).
    index("measurements_project_metric_at").on(t.projectId, t.metric, t.at),
    index("measurements_item").on(t.itemId),
    index("measurements_parent").on(t.parentId),
    // At most one reading. Both null is a parent node (an occurrence with no reading of its own), which is
    // legitimate; both set is a row nobody could interpret, and a constraint says so better than a convention.
    check("measurements_one_reading", sql`NOT (${t.value} IS NOT NULL AND ${t.textValue} IS NOT NULL)`),
  ],
);

/**
 * The order we agreed to work in (`PROJ-8`): a short ordered list of items, held on the project beside
 * `direction`.
 *
 * **A join table rather than a `text[]` on `projects`**, because Postgres cannot put a foreign key on array
 * elements, and an unenforced reference would be the only one in this schema - `dependencies` is a real join
 * table, `parent_id` is an FK, and `apm:check` validates every dep and parent ref on top. The YAML is
 * unaffected: it exports as `next: [PROJ-8, METRIC-1]`, exactly as `dependencies` exports as `deps:`.
 *
 * `position` is rewritten wholesale on every write. Ten rows and one call, so there is no fractional-index
 * scheme to maintain, and the unique index is what stops two items claiming the same slot.
 *
 * The cascade is real but will rarely fire: items are soft-deleted (`deleted_at`, no hard-delete path), so a
 * deleted item stays in this table and is **filtered on read** instead. That is deliberate - dropping it on
 * write would be mutating stored state from derived state, and it keeps the row recoverable if the item is
 * undeleted.
 */
export const projectNext = pgTable(
  "project_next",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.itemId] }), uniqueIndex("project_next_position").on(t.projectId, t.position)],
);

// Append-only audit over every mutation, written in the same transaction as the change it records. This is
// what makes unattended agent edits reviewable and reversible. Locally these rows are flushed to a separate
// `events.jsonl` (out of the human-readable plan YAML); see IMP-7.
//
// (entity_type, entity_id) is the one polymorphic reference pattern the rest of the schema reuses. It
// carries no foreign key by necessity: a polymorphic column cannot have one, and an event must outlive the
// row it describes. `project_id` is null for project creation itself.
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(), // "project" | "item" | "dependency" | ... open
    entityId: text("entity_id").notNull(),
    at: text("at").notNull().$defaultFn(timestamp),
    actor: text("actor").notNull(), // who made the change; a real user id once projects are shared
    kind: text("kind").notNull(), // "created" | "updated" | "deleted" | ...
    // Groups the rows written by one domain operation, so history and a future undo (DATA-13) act on a
    // user-meaningful unit rather than a single row.
    correlationId: text("correlation_id"),
    before: text("before"), // opaque JSON, parsed by the application, never queried into in SQL
    after: text("after"),
  },
  (t) => [index("events_entity").on(t.entityType, t.entityId), index("events_project_at").on(t.projectId, t.at)],
);

// The project's living context as named prose sections (CTX): "Goals", "Assumptions", "Open questions", ...
// An open set of headings, revised in place with the change captured in the event log - the durable
// narrative a returning session reads. Distinct from the one-line `projects.direction` headline above it and
// from the time-ordered session journal below. Round-trips to a readable `context:` block in the plan YAML.
export const contextSections = pgTable(
  "context_sections",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    heading: text("heading").notNull(), // "Goals", "Open questions", ... open set
    content: text("content").notNull(), // a markdown block
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(timestamp),
    updatedAt: text("updated_at").notNull().$defaultFn(timestamp),
    // Full-text search (DATA-11). Maintained by Postgres inside the same write, never by us.
    tsv: tsvector("tsv").generatedAlwaysAs(() => searchVector(["heading", "A"], ["content", "B"])),
  },
  (t) => [
    uniqueIndex("context_sections_project_heading").on(t.projectId, t.heading), // set by heading = upsert
    index("context_sections_project_order").on(t.projectId, t.sortOrder),
    index("context_sections_tsv").using("gin", t.tsv),
  ],
);

// Free prose jotted down as the work happens (CTX-2): the cheap, append-only counterpart to a context
// section. A section carries the project's settled narrative and is revised in place; a note is written once,
// in the moment, and never rewritten - which is exactly what makes it cheap enough to write *often*. That
// distinction is the point of the table: when the only way to record something is to rewrite a whole section,
// an agent mid-task defers it, and deferred writes are lost writes.
// Optionally attached to an item, so "reached for this and could not say it" hangs off the ticket it came up
// on. Attachment is a nullable FK rather than a polymorphic subject_type/subject_id pair, so the database
// still enforces that the thing pointed at exists.
export const comments = pgTable(
  "comments",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    itemId: text("item_id").references(() => items.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    // "user" | "agent". Agent comments are Claude's own working store, kept out of the board and user-facing
    // summaries so they do not clutter what a human reads. Not secret: same database, same event log,
    // readable by any tool call, and the viewer gets a toggle (VIEW-8). Open set, like every other vocabulary
    // column here - the domain layer validates it.
    audience: text("audience").notNull().default("user"),
    actor: text("actor").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(timestamp),
    // Full-text search (DATA-11). Maintained by Postgres inside the same write, never by us.
    // Body only, weighted `A`: a comment has no title, so there is no second field to rank it against.
    tsv: tsvector("tsv").generatedAlwaysAs(() => searchVector(["body", "A"])),
  },
  (t) => [
    index("comments_project_created").on(t.projectId, t.createdAt),
    index("comments_item").on(t.itemId),
    index("comments_tsv").using("gin", t.tsv),
  ],
);

// Images attached to a ticket (MEDIA-1): a plant photographed monthly, a meal, a calorie label. Only the
// *reference* lives here and in the YAML - never the bytes, which would destroy the deterministic one-line
// diff the plan file depends on and could not survive a rebuild from a file they had bloated. The bytes sit
// beside the store under `.apm/media/`, behind the MediaStore seam, so the cloud swaps the implementation and
// nothing else (OPS-11).
//
// `hash` is the whole identity: content-addressed, so identical images stored twice are one blob, a blob is
// immutable and therefore cacheable, and moving or renaming a file can never break a reference. It is also
// what makes an eventual migration to object storage a copy rather than a rewrite, since both sides agree on
// a name for free.
//
// Attached by nullable FK rather than a polymorphic pair, following `comments` directly above: the database
// still enforces that the ticket exists, and widening to comments later is another nullable column rather
// than a redesign.
export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    itemId: text("item_id").references(() => items.id, { onDelete: "cascade" }),
    hash: text("hash").notNull(), // sha256 of the bytes, hex
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    caption: text("caption"),
    actor: text("actor").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(timestamp),
  },
  (t) => [
    index("attachments_project_item").on(t.projectId, t.itemId),
    index("attachments_hash").on(t.hash),
    // The same image attached twice to one ticket is a mistake, not a use case: content addressing already
    // means it is one blob, so the second row would render a duplicate thumbnail of the identical picture.
    uniqueIndex("attachments_item_hash").on(t.projectId, t.itemId, t.hash),
  ],
);

