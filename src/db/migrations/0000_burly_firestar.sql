CREATE TABLE "areas" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"colour" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dependencies" (
	"item_id" text NOT NULL,
	"depends_on_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "dependencies_item_id_depends_on_id_pk" PRIMARY KEY("item_id","depends_on_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"at" text NOT NULL,
	"actor" text NOT NULL,
	"kind" text NOT NULL,
	"correlation_id" text,
	"before" text,
	"after" text
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"ref" text NOT NULL,
	"area_key" text NOT NULL,
	"sort_path" text NOT NULL,
	"parent_id" text,
	"title" text NOT NULL,
	"body" text,
	"status" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"closed_at" text,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"direction" text,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"archived_at" text,
	CONSTRAINT "projects_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "areas" ADD CONSTRAINT "areas_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_depends_on_id_items_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_parent_id_items_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "areas_project_key" ON "areas" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "dependencies_depends_on" ON "dependencies" USING btree ("depends_on_id");--> statement-breakpoint
CREATE INDEX "events_entity" ON "events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "events_project_at" ON "events" USING btree ("project_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "items_project_ref" ON "items" USING btree ("project_id","ref");--> statement-breakpoint
CREATE INDEX "items_project_status" ON "items" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "items_project_area" ON "items" USING btree ("project_id","area_key");--> statement-breakpoint
CREATE INDEX "items_project_sort" ON "items" USING btree ("project_id","sort_path");--> statement-breakpoint
CREATE INDEX "items_parent" ON "items" USING btree ("parent_id");