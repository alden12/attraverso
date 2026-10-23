CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"item_id" text,
	"hash" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"caption" text,
	"actor" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_project_item" ON "attachments" USING btree ("project_id","item_id");--> statement-breakpoint
CREATE INDEX "attachments_hash" ON "attachments" USING btree ("hash");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_item_hash" ON "attachments" USING btree ("project_id","item_id","hash");