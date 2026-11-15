CREATE TABLE "source_references" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"item_id" text,
	"section_id" text,
	"source" text NOT NULL,
	"detail" text NOT NULL,
	"quoted_text" text NOT NULL,
	"actor" text NOT NULL,
	"recorded_at" text NOT NULL,
	"retired_at" text,
	CONSTRAINT "source_references_one_owner" CHECK (("source_references"."item_id" IS NULL) <> ("source_references"."section_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "source_references" ADD CONSTRAINT "source_references_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_references" ADD CONSTRAINT "source_references_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_references" ADD CONSTRAINT "source_references_section_id_context_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."context_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_references_project_key" ON "source_references" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "source_references_item" ON "source_references" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "source_references_section" ON "source_references" USING btree ("section_id");--> statement-breakpoint
-- CTX-13: every live source reference's pointer is in its owner's text, and a key has one owner. Hand-written: a
-- trigger is beyond what drizzle-kit generates. Deferred to commit, so a reference and its pointer can arrive in
-- either order within one transaction. Each firing checks only the item, section or key that changed. Loading a
-- plan file sets attraverso.loading_plan for its transaction and is let through: a hand edit that broke a
-- pointer must still load (stale is a state a plan loads in, never a refusal to load), and apm:check reports it.
-- A pointer is "[ref key]" or the expanded "[ref key: ...]", matched exactly so r7k2 never matches r7k29.
CREATE FUNCTION "source_references_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bad text;
BEGIN
  IF current_setting('attraverso.loading_plan', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'items' THEN
    SELECT r.key INTO bad FROM source_references r JOIN items i ON i.id = r.item_id
      WHERE r.item_id = NEW.id AND r.retired_at IS NULL
        AND position('[ref ' || r.key || ']' IN coalesce(i.body, '')) = 0
        AND position('[ref ' || r.key || ':' IN coalesce(i.body, '')) = 0
      LIMIT 1;
  ELSIF TG_TABLE_NAME = 'context_sections' THEN
    SELECT r.key INTO bad FROM source_references r JOIN context_sections c ON c.id = r.section_id
      WHERE r.section_id = NEW.id AND r.retired_at IS NULL
        AND position('[ref ' || r.key || ']' IN c.content) = 0
        AND position('[ref ' || r.key || ':' IN c.content) = 0
      LIMIT 1;
  ELSE
    SELECT r.key INTO bad FROM source_references r
      LEFT JOIN items i ON i.id = r.item_id LEFT JOIN context_sections c ON c.id = r.section_id
      WHERE r.project_id = NEW.project_id AND r.key = NEW.key AND r.retired_at IS NULL
        AND position('[ref ' || r.key || ']' IN coalesce(i.body, c.content, '')) = 0
        AND position('[ref ' || r.key || ':' IN coalesce(i.body, c.content, '')) = 0
      LIMIT 1;
    IF bad IS NULL THEN
      SELECT r.key INTO bad FROM source_references r
        WHERE r.project_id = NEW.project_id AND r.key = NEW.key AND r.retired_at IS NULL
        GROUP BY r.key HAVING count(DISTINCT coalesce(r.item_id, r.section_id)) > 1;
      IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'source reference % has more than one owner', bad USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'source reference % is live but its pointer is not in the text', bad USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "source_references_on_items" AFTER UPDATE OF "body" ON "items"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "source_references_check"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "source_references_on_sections" AFTER UPDATE OF "content" ON "context_sections"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "source_references_check"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "source_references_on_rows" AFTER INSERT OR UPDATE ON "source_references"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "source_references_check"();
