ALTER TABLE "notes" RENAME TO "comments";--> statement-breakpoint
ALTER TABLE "comments" DROP CONSTRAINT "notes_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "comments" DROP CONSTRAINT "notes_item_id_items_id_fk";
--> statement-breakpoint
DROP INDEX "notes_project_created";--> statement-breakpoint
DROP INDEX "notes_item";--> statement-breakpoint
DROP INDEX "notes_tsv";--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_project_created" ON "comments" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_item" ON "comments" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "comments_tsv" ON "comments" USING gin ("tsv");