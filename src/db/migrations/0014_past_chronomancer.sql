ALTER TABLE "items" ADD COLUMN "start_on" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "due_on" text;--> statement-breakpoint
CREATE INDEX "items_project_due" ON "items" USING btree ("project_id","due_on");