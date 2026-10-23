CREATE TABLE "measurements" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"item_id" text,
	"parent_id" text,
	"metric" text NOT NULL,
	"value" double precision,
	"text_value" text,
	"unit" text,
	"label" text,
	"at" text NOT NULL,
	"source" text,
	"actor" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "measurements_one_reading" CHECK (NOT ("measurements"."value" IS NOT NULL AND "measurements"."text_value" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_parent_id_measurements_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."measurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "measurements_project_metric_at" ON "measurements" USING btree ("project_id","metric","at");--> statement-breakpoint
CREATE INDEX "measurements_item" ON "measurements" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "measurements_parent" ON "measurements" USING btree ("parent_id");