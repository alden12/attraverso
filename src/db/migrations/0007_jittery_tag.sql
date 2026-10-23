ALTER TABLE "context_sections" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("heading", '')), 'A') || setweight(to_tsvector('english', coalesce("content", '')), 'B')) STORED;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("title", '')), 'A') || setweight(to_tsvector('english', coalesce("body", '')), 'B')) STORED;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("body", '')), 'A')) STORED;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("summary", '')), 'A')) STORED;--> statement-breakpoint
CREATE INDEX "context_sections_tsv" ON "context_sections" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "items_tsv" ON "items" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "notes_tsv" ON "notes" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "sessions_tsv" ON "sessions" USING gin ("tsv");