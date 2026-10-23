CREATE TABLE "context_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"heading" text NOT NULL,
	"content" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"started_at" text NOT NULL,
	"ended_at" text,
	"summary" text,
	"actor" text NOT NULL,
	"compacted_into" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_sections" ADD CONSTRAINT "context_sections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_compacted_into_sessions_id_fk" FOREIGN KEY ("compacted_into") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "context_sections_project_heading" ON "context_sections" USING btree ("project_id","heading");--> statement-breakpoint
CREATE INDEX "context_sections_project_order" ON "context_sections" USING btree ("project_id","sort_order");--> statement-breakpoint
CREATE INDEX "sessions_project_started" ON "sessions" USING btree ("project_id","started_at");