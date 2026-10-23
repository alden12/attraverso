CREATE TABLE "scoped_dependencies" (
	"item_id" text NOT NULL,
	"target_project" text NOT NULL,
	"target_ref" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "scoped_dependencies_item_id_target_project_target_ref_pk" PRIMARY KEY("item_id","target_project","target_ref")
);
--> statement-breakpoint
ALTER TABLE "scoped_dependencies" ADD CONSTRAINT "scoped_dependencies_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;