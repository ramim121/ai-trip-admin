-- Let a quote price a journey as well as an itinerary.
--
-- ONE PRICING PIPELINE, NOT TWO. Quotes already own revisions, the
-- immutable-once-sent trigger, the arithmetic CHECK, the ops queue and the
-- accept/decline predicate. A second table for journey quotes would duplicate
-- every one of those, and the copy nobody remembers is the one that stops
-- enforcing the rule.
--
-- So a quote points at exactly one of the two planners. The admin prices both on
-- the same screen, which is right operationally too: "what does this trip cost"
-- does not change depending on which planner drew it.

ALTER TABLE "quotes" ADD COLUMN "journeyId" UUID;

ALTER TABLE "quotes" ADD CONSTRAINT "quotes_journeyId_fkey"
  FOREIGN KEY ("journeyId") REFERENCES "journeys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "quotes_journeyId_idx" ON "quotes"("journeyId");

-- Exactly one subject, or none.
--
-- Both set would be a quote for two different trips, and the ops screen would
-- render whichever it read first. Neither set is already legal and stays so:
-- SetNull on both foreign keys means a deleted trip leaves the quote behind as a
-- record, which is deliberate — the money conversation happened even if the plan
-- is gone.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_has_at_most_one_subject"
  CHECK (NOT ("itineraryId" IS NOT NULL AND "journeyId" IS NOT NULL));

-- One open quote per journey, mirroring the itinerary rule.
--
-- Asking twice while a conversation is open is the same conversation. Partial
-- rather than plain, because asking again after a decline IS a new request —
-- exactly the case the itinerary index was written for.
CREATE UNIQUE INDEX "quotes_one_open_per_journey"
  ON "quotes" ("journeyId")
  WHERE "status" IN ('REQUESTED', 'PRICED', 'SENT') AND "journeyId" IS NOT NULL;
