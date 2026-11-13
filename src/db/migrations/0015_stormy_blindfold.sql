CREATE TABLE "layout_positions" (
	"project_id" text NOT NULL,
	"node" text NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	CONSTRAINT "layout_positions_project_id_node_pk" PRIMARY KEY("project_id","node")
);
--> statement-breakpoint
ALTER TABLE "layout_positions" ADD CONSTRAINT "layout_positions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;