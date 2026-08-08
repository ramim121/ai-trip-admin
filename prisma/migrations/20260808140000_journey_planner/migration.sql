-- The AI itinerary planner: journeys, their items, and the preference briefs
-- behind them.
--
-- Parallel to itineraries rather than an extension of them. An itinerary block
-- must reference a catalogue activity — a foreign key says so — because the
-- curated planner sells what it recommends. A journey item may instead name a
-- Viator product or a Google place, because what a journey sells is a
-- QUOTATION: every figure here is an estimate, and the admin replaces it with a
-- real vendor price before anybody is asked for money.

CREATE TYPE "JourneyStatus" AS ENUM ('PLANNING', 'QUOTATION_REQUESTED', 'QUOTED', 'ACCEPTED');
CREATE TYPE "DateBucket" AS ENUM ('NEXT_WEEK', 'TWO_TO_FOUR_WEEKS', 'NEXT_MONTH', 'CUSTOM');
CREATE TYPE "DaySlot" AS ENUM ('MORNING', 'AFTERNOON', 'EVENING');
CREATE TYPE "JourneyItemType" AS ENUM ('ACTIVITY', 'STAY', 'FOOD', 'TRANSFER');
CREATE TYPE "ItemOrigin" AS ENUM ('USER_PINNED', 'AI_SUGGESTED');
CREATE TYPE "ItemSource" AS ENUM ('VIATOR', 'GOOGLE_PLACES', 'CURATED', 'AI_ESTIMATE');
CREATE TYPE "BriefPillar" AS ENUM ('STAY', 'ACTIVITY', 'FOOD', 'TRANSPORT');
CREATE TYPE "BudgetScope" AS ENUM ('TOTAL_TRIP', 'PER_PERSON', 'PER_NIGHT');

-- ── journeys ────────────────────────────────────────────────────────────────

CREATE TABLE "journeys" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "shareToken" TEXT NOT NULL,
    "title" TEXT,
    "rawIntake" TEXT,
    "destinations" TEXT[],
    "durationDays" INTEGER NOT NULL,
    "dateBucket" "DateBucket" NOT NULL DEFAULT 'CUSTOM',
    "startDate" DATE,
    "endDate" DATE,
    "partyAdults" INTEGER NOT NULL DEFAULT 2,
    "partyChildren" INTEGER NOT NULL DEFAULT 0,
    "partyType" TEXT,
    "tripType" TEXT,
    "interests" TEXT[],
    "budgetMinBdt" INTEGER,
    "budgetMaxBdt" INTEGER,
    "budgetScope" "BudgetScope" NOT NULL DEFAULT 'TOTAL_TRIP',
    "status" "JourneyStatus" NOT NULL DEFAULT 'PLANNING',
    "quoteId" UUID,
    "contactWhatsapp" TEXT,
    "contactEmail" TEXT,
    "contactPreferredTime" TEXT,
    "userNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journeys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "journeys_shareToken_key" ON "journeys"("shareToken");
CREATE INDEX "journeys_userId_updatedAt_idx" ON "journeys"("userId", "updatedAt");
CREATE INDEX "journeys_status_updatedAt_idx" ON "journeys"("status", "updatedAt");

ALTER TABLE "journeys" ADD CONSTRAINT "journeys_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A share token has to be long enough that guessing one is not a strategy.
-- Twenty characters is the shortest thing that is honestly random; below that,
-- the "no login required to view" promise starts leaking other people's plans.
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_share_token_is_long_enough"
  CHECK (length("shareToken") >= 20);

-- A trip has a length, bounded at both ends. Zero days is not a trip, and a
-- year is somebody testing the input rather than planning a holiday.
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_duration_is_sane"
  CHECK ("durationDays" >= 1 AND "durationDays" <= 60);

ALTER TABLE "journeys" ADD CONSTRAINT "journeys_party_is_sane"
  CHECK (
    "partyAdults" >= 1 AND "partyAdults" <= 40
    AND "partyChildren" >= 0 AND "partyChildren" <= 40
  );

-- A budget range that runs backwards is a parse error, and it would render as a
-- meter filling to somewhere behind its own start.
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_budget_range_ordered"
  CHECK (
    "budgetMinBdt" IS NULL
    OR "budgetMaxBdt" IS NULL
    OR "budgetMaxBdt" >= "budgetMinBdt"
  );

ALTER TABLE "journeys" ADD CONSTRAINT "journeys_budget_not_negative"
  CHECK (
    ("budgetMinBdt" IS NULL OR "budgetMinBdt" >= 0)
    AND ("budgetMaxBdt" IS NULL OR "budgetMaxBdt" >= 0)
  );

ALTER TABLE "journeys" ADD CONSTRAINT "journeys_dates_ordered"
  CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "startDate");

-- ── journey_items ───────────────────────────────────────────────────────────

CREATE TABLE "journey_items" (
    "id" UUID NOT NULL,
    "journeyId" UUID NOT NULL,
    "dayNumber" INTEGER NOT NULL,
    "slot" "DaySlot" NOT NULL,
    "startMinute" INTEGER,
    "durationMin" INTEGER,
    "type" "JourneyItemType" NOT NULL,
    "origin" "ItemOrigin" NOT NULL DEFAULT 'AI_SUGGESTED',
    "source" "ItemSource" NOT NULL DEFAULT 'AI_ESTIMATE',
    "externalId" TEXT,
    "activityId" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "estPriceMinBdt" INTEGER,
    "estPriceMaxBdt" INTEGER,
    "estPricePer" TEXT,
    "matchReason" TEXT,
    "locationName" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "snapshot" JSONB,
    "briefId" UUID,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journey_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "journey_items_journeyId_dayNumber_slot_idx"
  ON "journey_items"("journeyId", "dayNumber", "slot");
CREATE INDEX "journey_items_activityId_idx" ON "journey_items"("activityId");

ALTER TABLE "journey_items" ADD CONSTRAINT "journey_items_journeyId_fkey"
  FOREIGN KEY ("journeyId") REFERENCES "journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "journey_items" ADD CONSTRAINT "journey_items_activityId_fkey"
  FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- THE SOURCE AND THE REFERENCE HAVE TO AGREE.
--
-- A CURATED item names a catalogue row; a VIATOR or GOOGLE_PLACES item names an
-- external id and no catalogue row. An item claiming to be curated with nothing
-- behind it is the exact shape of a hallucination reaching a quotation, so it
-- is refused here rather than spotted by eye later.
ALTER TABLE "journey_items" ADD CONSTRAINT "journey_items_source_matches_reference"
  CHECK (
    ("source" = 'CURATED' AND "activityId" IS NOT NULL)
    OR ("source" IN ('VIATOR', 'GOOGLE_PLACES') AND "externalId" IS NOT NULL AND "activityId" IS NULL)
    OR ("source" = 'AI_ESTIMATE' AND "activityId" IS NULL)
  );

-- Estimates are ranges, and a range runs forwards.
ALTER TABLE "journey_items" ADD CONSTRAINT "journey_items_price_range_ordered"
  CHECK (
    "estPriceMinBdt" IS NULL
    OR "estPriceMaxBdt" IS NULL
    OR "estPriceMaxBdt" >= "estPriceMinBdt"
  );

ALTER TABLE "journey_items" ADD CONSTRAINT "journey_items_price_not_negative"
  CHECK (
    ("estPriceMinBdt" IS NULL OR "estPriceMinBdt" >= 0)
    AND ("estPriceMaxBdt" IS NULL OR "estPriceMaxBdt" >= 0)
  );

-- A time, when given, is a real time of day. A duration may run to a full day,
-- which is what an early-bird island tour actually is.
ALTER TABLE "journey_items" ADD CONSTRAINT "journey_items_time_is_sane"
  CHECK (
    ("startMinute" IS NULL OR ("startMinute" >= 0 AND "startMinute" < 1440))
    AND ("durationMin" IS NULL OR ("durationMin" > 0 AND "durationMin" <= 1440))
  );

-- An item belongs to a day of the trip it is in.
--
-- Not expressible as a foreign key, because a day here is a number rather than
-- a row. Without this, a bad edit puts day 9 on a seven-day trip, where nothing
-- renders it and the traveller cannot find what they just added.
CREATE OR REPLACE FUNCTION "journey_item_day_within_trip"() RETURNS TRIGGER AS $$
DECLARE
  trip_days INTEGER;
BEGIN
  SELECT "durationDays" INTO trip_days FROM "journeys" WHERE "id" = NEW."journeyId";

  IF NEW."dayNumber" < 1 OR NEW."dayNumber" > trip_days THEN
    RAISE EXCEPTION 'day % is outside this trip, which is % days long', NEW."dayNumber", trip_days
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journey_items_day_within_trip"
  BEFORE INSERT OR UPDATE OF "dayNumber", "journeyId" ON "journey_items"
  FOR EACH ROW EXECUTE FUNCTION "journey_item_day_within_trip"();

-- ── preference_briefs ───────────────────────────────────────────────────────

CREATE TABLE "preference_briefs" (
    "id" UUID NOT NULL,
    "journeyId" UUID NOT NULL,
    "pillar" "BriefPillar" NOT NULL,
    "location" TEXT NOT NULL,
    "nights" INTEGER,
    "constraints" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "history" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preference_briefs_pkey" PRIMARY KEY ("id")
);

-- One brief per pillar per place. Two would split the constraints, and the
-- ranker would read half of them — which looks, from the outside, exactly like
-- the AI ignoring what the traveller just said.
CREATE UNIQUE INDEX "preference_briefs_journeyId_pillar_location_key"
  ON "preference_briefs"("journeyId", "pillar", "location");

ALTER TABLE "preference_briefs" ADD CONSTRAINT "preference_briefs_journeyId_fkey"
  FOREIGN KEY ("journeyId") REFERENCES "journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "journey_items" ADD CONSTRAINT "journey_items_briefId_fkey"
  FOREIGN KEY ("briefId") REFERENCES "preference_briefs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A brief nobody can read is not a brief. The summary is what renders as chips
-- and what the admin reads first.
ALTER TABLE "preference_briefs" ADD CONSTRAINT "preference_briefs_has_summary"
  CHECK (btrim("summary") <> '');

ALTER TABLE "preference_briefs" ADD CONSTRAINT "preference_briefs_location_not_blank"
  CHECK (btrim("location") <> '');

-- ── route_estimates ─────────────────────────────────────────────────────────

CREATE TABLE "route_estimates" (
    "id" UUID NOT NULL,
    "fromLocation" TEXT NOT NULL,
    "toLocation" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "durationMinMinutes" INTEGER NOT NULL,
    "durationMaxMinutes" INTEGER NOT NULL,
    "priceMinBdt" INTEGER NOT NULL,
    "priceMaxBdt" INTEGER NOT NULL,
    "pricePer" TEXT NOT NULL DEFAULT 'person',
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_estimates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "route_estimates_fromLocation_toLocation_mode_key"
  ON "route_estimates"("fromLocation", "toLocation", "mode");
CREATE INDEX "route_estimates_fromLocation_toLocation_isActive_idx"
  ON "route_estimates"("fromLocation", "toLocation", "isActive");

-- Lookups are exact and case-folded on write, so "Krabi" and "krabi" are one
-- route rather than two rows each answering half the questions.
ALTER TABLE "route_estimates" ADD CONSTRAINT "route_estimates_locations_are_folded"
  CHECK (
    "fromLocation" = lower(btrim("fromLocation")) AND btrim("fromLocation") <> ''
    AND "toLocation" = lower(btrim("toLocation")) AND btrim("toLocation") <> ''
  );

-- A route goes somewhere. A same-place row would draw a transfer card between
-- an item and itself.
ALTER TABLE "route_estimates" ADD CONSTRAINT "route_estimates_goes_somewhere"
  CHECK ("fromLocation" <> "toLocation");

ALTER TABLE "route_estimates" ADD CONSTRAINT "route_estimates_ranges_ordered"
  CHECK (
    "durationMaxMinutes" >= "durationMinMinutes"
    AND "durationMinMinutes" > 0
    AND "priceMaxBdt" >= "priceMinBdt"
    AND "priceMinBdt" >= 0
  );

-- ── provider_cache ──────────────────────────────────────────────────────────

CREATE TABLE "provider_cache" (
    "cacheKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_cache_pkey" PRIMARY KEY ("cacheKey")
);

CREATE INDEX "provider_cache_expiresAt_idx" ON "provider_cache"("expiresAt");
CREATE INDEX "provider_cache_provider_endpoint_idx" ON "provider_cache"("provider", "endpoint");

-- A cache row that never expires is not a cache, it is a copy of somebody
-- else's database — which is the thing both providers' terms forbid.
ALTER TABLE "provider_cache" ADD CONSTRAINT "provider_cache_expires"
  CHECK ("expiresAt" > "fetchedAt");
