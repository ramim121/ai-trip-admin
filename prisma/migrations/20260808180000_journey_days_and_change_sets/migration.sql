-- A day is a thing in its own right, and the last AI turn is visible.
--
-- Two additions that look unrelated and are not. Both exist because a plan is
-- edited by conversation now: a conversation needs somewhere to put what it said
-- about a day, and somewhere to record what it just did.

-- ── journey_days ────────────────────────────────────────────────────────────
--
-- Until now a day was an integer on an item and nothing else. That is enough to
-- group a list and not enough to say "Day 3 — Krabi, the quiet half of the trip,
-- and we move hotels in the morning."
--
-- THREE KINDS OF TEXT, KEPT APART ON PURPOSE:
--   `locationName` is a fact — where this day happens. The skeleton writes it,
--   and the transfer finder already leans on the same fact living on items.
--   `summary` is ours: one line the model wrote about the shape of the day.
--   `note` is theirs: whatever the traveller typed, never overwritten by us.
--
-- Merging `summary` and `note` into one column would mean regenerating a day
-- silently destroys what somebody wrote about their own holiday, and they would
-- find out afterwards.

CREATE TABLE "journey_days" (
    "id" UUID NOT NULL,
    "journeyId" UUID NOT NULL,

    -- 1-based, matching journey_items. Day 1 is the first day, not an index.
    "dayNumber" INTEGER NOT NULL,

    "locationName" TEXT,
    "title" TEXT,

    -- What the model said this day is. Regenerated freely.
    "summary" TEXT,

    -- What the traveller said. Ours to store and never to rewrite.
    "note" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journey_days_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "journey_days" ADD CONSTRAINT "journey_days_journeyId_fkey"
  FOREIGN KEY ("journeyId") REFERENCES "journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One row per day per trip. Two rows for day 3 is two answers to one question,
-- and whichever the reader happens to pick is the one that is wrong.
CREATE UNIQUE INDEX "journey_days_journeyId_dayNumber_key"
  ON "journey_days"("journeyId", "dayNumber");

ALTER TABLE "journey_days" ADD CONSTRAINT "journey_days_text_is_bounded"
  CHECK (
    "dayNumber" >= 1
    AND ("note" IS NULL OR length("note") <= 2000)
    AND ("summary" IS NULL OR length("summary") <= 500)
    AND ("title" IS NULL OR length("title") <= 120)
  );

-- The same guard journey_items carries, for the same reason: a day past the end
-- of the trip is a row nothing will ever read, written by something that
-- believed the trip was longer than it is.
CREATE OR REPLACE FUNCTION "journey_day_within_trip"() RETURNS TRIGGER AS $$
DECLARE trip_days INTEGER;
BEGIN
  SELECT "durationDays" INTO trip_days FROM "journeys" WHERE "id" = NEW."journeyId";

  IF NEW."dayNumber" > trip_days THEN
    RAISE EXCEPTION 'day % is outside this trip, which is % days long', NEW."dayNumber", trip_days
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journey_days_within_trip"
  BEFORE INSERT OR UPDATE ON "journey_days"
  FOR EACH ROW EXECUTE FUNCTION "journey_day_within_trip"();

-- ── change sets ─────────────────────────────────────────────────────────────
--
-- WHAT DID IT JUST DO?
--
-- A traveller types "give day 2 to Universal Studios and a good dinner", the
-- plan redraws, and four cards are different. With nothing marking them, finding
-- which four means comparing the screen against a memory of the screen — and
-- that is the moment people stop trusting a thing that edits their work.
--
-- One id per AI turn, stamped on the journey and on every item that turn
-- touched. An item belongs to the last change exactly when its id matches the
-- journey's, which stays true across a reload and needs no client state at all.
--
-- NULLABLE ON BOTH SIDES, because most items were never touched by any turn and
-- a plan may never have had one.

ALTER TABLE "journeys" ADD COLUMN "lastChangeSetId" UUID;
ALTER TABLE "journey_items" ADD COLUMN "changeSetId" UUID;

-- Partial: the overwhelming majority of items carry no change set, and an index
-- over a column that is mostly NULL is mostly wasted pages.
CREATE INDEX "journey_items_changeSetId_idx"
  ON "journey_items"("changeSetId") WHERE "changeSetId" IS NOT NULL;
