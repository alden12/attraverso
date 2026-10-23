CREATE TABLE "project_next" (
	"project_id" text NOT NULL,
	"item_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "project_next_project_id_item_id_pk" PRIMARY KEY("project_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "project_next" ADD CONSTRAINT "project_next_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_next" ADD CONSTRAINT "project_next_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_next_position" ON "project_next" USING btree ("project_id","position");