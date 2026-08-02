-- CreateEnum
CREATE TYPE "AiSurface" AS ENUM ('TEASER', 'PLANNER', 'DAY_REGENERATION', 'SUGGESTION');

-- CreateEnum
CREATE TYPE "AiCallOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'REFUSED');

-- CreateEnum
CREATE TYPE "PackageScope" AS ENUM ('DOMESTIC', 'INTERNATIONAL');

-- CreateEnum
CREATE TYPE "PackageKind" AS ENUM ('GROUP', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "PackagePricingMode" AS ENUM ('FIXED_PRICE', 'INTEREST_ONLY');

-- CreateEnum
CREATE TYPE "PackageStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DepartureStatus" AS ENUM ('SCHEDULED', 'GUARANTEED', 'SOLD_OUT', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "TripLeaderRole" AS ENUM ('LEADER', 'MANAGER', 'GUIDE');

-- CreateEnum
CREATE TYPE "PackageInterestStatus" AS ENUM ('NEW', 'CONTACTED', 'CONVERTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PollStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "ai_usage_events" (
    "id" UUID NOT NULL,
    "surface" "AiSurface" NOT NULL,
    "outcome" "AiCallOutcome" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelSource" TEXT NOT NULL,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "latencyMs" INTEGER,
    "errorKind" TEXT,
    "userId" UUID,
    "anonymousVisitorId" UUID,
    "plannerSessionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_packages" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "scope" "PackageScope" NOT NULL,
    "kind" "PackageKind" NOT NULL,
    "pricingMode" "PackagePricingMode" NOT NULL,
    "destinationId" UUID,
    "destinationLabel" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "durationNights" INTEGER NOT NULL,
    "priceFromBdt" INTEGER,
    "priceToBdt" INTEGER,
    "groupSizeMin" INTEGER,
    "groupSizeMax" INTEGER,
    "heroImageUrl" TEXT,
    "cardImageUrl" TEXT,
    "highlights" TEXT[],
    "inclusions" TEXT[],
    "exclusions" TEXT[],
    "status" "PackageStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "travel_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_departures" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "capacity" INTEGER NOT NULL,
    "seatsTaken" INTEGER NOT NULL DEFAULT 0,
    "priceBdt" INTEGER,
    "status" "DepartureStatus" NOT NULL DEFAULT 'SCHEDULED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "package_departures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_itinerary_days" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "dayNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "accommodation" TEXT,
    "meals" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "package_itinerary_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_itinerary_items" (
    "id" UUID NOT NULL,
    "dayId" UUID NOT NULL,
    "kind" "ItineraryBlockKind" NOT NULL DEFAULT 'ACTIVITY',
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "startMinute" INTEGER,
    "durationMinutes" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "package_itinerary_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_leaders" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "TripLeaderRole" NOT NULL DEFAULT 'LEADER',
    "headline" TEXT NOT NULL,
    "bio" TEXT NOT NULL,
    "photoUrl" TEXT,
    "yearsExperience" INTEGER,
    "tripsLed" INTEGER NOT NULL DEFAULT 0,
    "languages" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trip_leaders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_leaders" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "leaderId" UUID NOT NULL,
    "role" "TripLeaderRole" NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "package_leaders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_interests" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "departureId" UUID,
    "userId" UUID,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "partySize" INTEGER NOT NULL DEFAULT 1,
    "message" TEXT,
    "status" "PackageInterestStatus" NOT NULL DEFAULT 'NEW',
    "contactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "package_interests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "polls" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "description" TEXT,
    "status" "PollStatus" NOT NULL DEFAULT 'DRAFT',
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "showResultsBeforeVote" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "polls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poll_options" (
    "id" UUID NOT NULL,
    "pollId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "subtitle" TEXT,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "voteCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "poll_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poll_votes" (
    "id" UUID NOT NULL,
    "pollId" UUID NOT NULL,
    "optionId" UUID NOT NULL,
    "userId" UUID,
    "anonymousVisitorId" UUID,
    "voterKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "poll_votes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_events_createdAt_idx" ON "ai_usage_events"("createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_events_model_createdAt_idx" ON "ai_usage_events"("model", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_events_surface_createdAt_idx" ON "ai_usage_events"("surface", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_events_userId_createdAt_idx" ON "ai_usage_events"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "travel_packages_slug_key" ON "travel_packages"("slug");

-- CreateIndex
CREATE INDEX "travel_packages_status_scope_sortOrder_idx" ON "travel_packages"("status", "scope", "sortOrder");

-- CreateIndex
CREATE INDEX "travel_packages_destinationId_idx" ON "travel_packages"("destinationId");

-- CreateIndex
CREATE INDEX "package_departures_startDate_status_idx" ON "package_departures"("startDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "package_departures_packageId_startDate_key" ON "package_departures"("packageId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "package_itinerary_days_packageId_dayNumber_key" ON "package_itinerary_days"("packageId", "dayNumber");

-- CreateIndex
CREATE INDEX "package_itinerary_items_dayId_position_idx" ON "package_itinerary_items"("dayId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "trip_leaders_slug_key" ON "trip_leaders"("slug");

-- CreateIndex
CREATE INDEX "trip_leaders_isActive_sortOrder_idx" ON "trip_leaders"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "package_leaders_leaderId_idx" ON "package_leaders"("leaderId");

-- CreateIndex
CREATE UNIQUE INDEX "package_leaders_packageId_leaderId_key" ON "package_leaders"("packageId", "leaderId");

-- CreateIndex
CREATE INDEX "package_interests_packageId_status_idx" ON "package_interests"("packageId", "status");

-- CreateIndex
CREATE INDEX "package_interests_departureId_idx" ON "package_interests"("departureId");

-- CreateIndex
CREATE UNIQUE INDEX "package_interests_packageId_email_key" ON "package_interests"("packageId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "polls_slug_key" ON "polls"("slug");

-- CreateIndex
CREATE INDEX "polls_status_sortOrder_idx" ON "polls"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "poll_options_pollId_sortOrder_idx" ON "poll_options"("pollId", "sortOrder");

-- CreateIndex
CREATE INDEX "poll_votes_optionId_idx" ON "poll_votes"("optionId");

-- CreateIndex
CREATE UNIQUE INDEX "poll_votes_pollId_voterKey_key" ON "poll_votes"("pollId", "voterKey");

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_anonymousVisitorId_fkey" FOREIGN KEY ("anonymousVisitorId") REFERENCES "anonymous_visitors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_plannerSessionId_fkey" FOREIGN KEY ("plannerSessionId") REFERENCES "planner_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_packages" ADD CONSTRAINT "travel_packages_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_departures" ADD CONSTRAINT "package_departures_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "travel_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_itinerary_days" ADD CONSTRAINT "package_itinerary_days_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "travel_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_itinerary_items" ADD CONSTRAINT "package_itinerary_items_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "package_itinerary_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_leaders" ADD CONSTRAINT "package_leaders_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "travel_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_leaders" ADD CONSTRAINT "package_leaders_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "trip_leaders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_interests" ADD CONSTRAINT "package_interests_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "travel_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_interests" ADD CONSTRAINT "package_interests_departureId_fkey" FOREIGN KEY ("departureId") REFERENCES "package_departures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_interests" ADD CONSTRAINT "package_interests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "poll_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_anonymousVisitorId_fkey" FOREIGN KEY ("anonymousVisitorId") REFERENCES "anonymous_visitors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Invariants Prisma cannot express.
--
-- Everything below is a rule the application also enforces. That is not a
-- reason to leave it out: the application is one code path among several — a
-- seed script, a console form, a psql session during an incident — and a rule
-- that only one of them honours is a rule the data will eventually break.
-- ─────────────────────────────────────────────────────────────────────────────

-- A package is priced or it is not, and the two modes are exclusive.
--
-- INTEREST_ONLY exists precisely because the trip has not been costed. A price
-- on one of those rows means the card shows a number nobody has agreed to
-- honour, which is worse than showing none. FIXED_PRICE without a price is the
-- same defect from the other side: the card would print "from BDT null".
ALTER TABLE "travel_packages" ADD CONSTRAINT "travel_packages_pricing_mode_agrees"
  CHECK (
    ("pricingMode" = 'INTEREST_ONLY' AND "priceFromBdt" IS NULL AND "priceToBdt" IS NULL)
    OR ("pricingMode" = 'FIXED_PRICE' AND "priceFromBdt" IS NOT NULL)
  );

-- Whole taka, never negative, and a range that runs the right way round.
-- `priceToBdt` with no `priceFromBdt` is a range with no floor, which renders
-- as "up to 40,000" — technically true and commercially meaningless.
ALTER TABLE "travel_packages" ADD CONSTRAINT "travel_packages_price_range_sane"
  CHECK (
    ("priceFromBdt" IS NULL OR "priceFromBdt" >= 0)
    AND ("priceToBdt" IS NULL OR ("priceFromBdt" IS NOT NULL AND "priceToBdt" >= "priceFromBdt"))
  );

-- A group size belongs to a GROUP trip. On an INDIVIDUAL package the band is
-- whatever the party is, so a stored range there is a number the page would
-- print at a traveller it does not apply to.
ALTER TABLE "travel_packages" ADD CONSTRAINT "travel_packages_group_size_sane"
  CHECK (
    ("kind" = 'GROUP' OR ("groupSizeMin" IS NULL AND "groupSizeMax" IS NULL))
    AND ("groupSizeMin" IS NULL OR "groupSizeMin" >= 1)
    AND ("groupSizeMax" IS NULL OR ("groupSizeMin" IS NOT NULL AND "groupSizeMax" >= "groupSizeMin"))
  );

-- A trip lasts at least a day, and nights are days minus the journey home.
ALTER TABLE "travel_packages" ADD CONSTRAINT "travel_packages_duration_positive"
  CHECK ("durationDays" >= 1 AND "durationNights" >= 0 AND "durationNights" <= "durationDays");

-- A departure that ends before it starts, or oversells itself.
--
-- `seatsTaken <= capacity` is the one that matters: it is what makes an
-- increment-on-booking safe to write without reading first, because the
-- statement that would take the twelfth seat on an eleven-seat bus fails
-- instead of succeeding quietly.
ALTER TABLE "package_departures" ADD CONSTRAINT "package_departures_dates_ordered"
  CHECK ("endDate" >= "startDate");

ALTER TABLE "package_departures" ADD CONSTRAINT "package_departures_seats_within_capacity"
  CHECK ("capacity" > 0 AND "seatsTaken" >= 0 AND "seatsTaken" <= "capacity");

ALTER TABLE "package_departures" ADD CONSTRAINT "package_departures_price_non_negative"
  CHECK ("priceBdt" IS NULL OR "priceBdt" >= 0);

-- Day 1 is the first day, not an index.
ALTER TABLE "package_itinerary_days" ADD CONSTRAINT "package_itinerary_days_day_number_positive"
  CHECK ("dayNumber" >= 1);

-- Minutes from local midnight, same as itinerary_blocks. An item may run past
-- midnight, so its END is unbounded, but its START is a time on the day it
-- belongs to.
ALTER TABLE "package_itinerary_items" ADD CONSTRAINT "package_itinerary_items_times_sane"
  CHECK (
    ("startMinute" IS NULL OR ("startMinute" >= 0 AND "startMinute" < 1440))
    AND ("durationMinutes" IS NULL OR "durationMinutes" > 0)
  );

-- At most one primary leader per package. A partial unique index, which is the
-- only way to say "unique among the rows where this is true" — the composite
-- unique Prisma can express would forbid a second non-primary leader too.
CREATE UNIQUE INDEX "package_leaders_one_primary_per_package"
  ON "package_leaders" ("packageId") WHERE "isPrimary";

-- A party of nobody is not a registration.
ALTER TABLE "package_interests" ADD CONSTRAINT "package_interests_party_size_positive"
  CHECK ("partySize" >= 1);

-- The unique index on (packageId, email) is case-sensitive, so it deduplicates
-- only if every writer normalises first. This makes that a guarantee rather
-- than a habit: a row written by a script that forgot is rejected here.
ALTER TABLE "package_interests" ADD CONSTRAINT "package_interests_email_normalised"
  CHECK ("email" = lower(btrim("email")));

-- A poll's window runs forwards.
ALTER TABLE "polls" ADD CONSTRAINT "polls_window_ordered"
  CHECK ("opensAt" IS NULL OR "closesAt" IS NULL OR "closesAt" > "opensAt");

ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_vote_count_non_negative"
  CHECK ("voteCount" >= 0);

-- A vote must be for an option OF THE POLL IT WAS CAST IN.
--
-- Two independent foreign keys are not enough: `poll_votes` points at a poll
-- and at an option separately, so nothing stops a row naming poll A and option
-- B. That is not a hypothetical typo — it is what a client sends by replaying
-- one poll's option id against another poll's endpoint, and the result is a
-- vote that counts towards totals it does not belong to while evading the
-- one-vote-per-poll unique index.
--
-- The fix is a composite foreign key, which needs a matching unique key on the
-- parent. `poll_options.id` is already unique on its own, so (id, pollId) adds
-- no restriction — it exists purely to be referenced.
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_id_pollId_key" UNIQUE ("id", "pollId");

ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_option_belongs_to_poll"
  FOREIGN KEY ("optionId", "pollId") REFERENCES "poll_options" ("id", "pollId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Token counts and latencies are measurements, and a negative measurement is a
-- bug in whatever wrote it, not a small number.
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_measurements_non_negative"
  CHECK (
    ("promptTokens" IS NULL OR "promptTokens" >= 0)
    AND ("completionTokens" IS NULL OR "completionTokens" >= 0)
    AND ("totalTokens" IS NULL OR "totalTokens" >= 0)
    AND ("latencyMs" IS NULL OR "latencyMs" >= 0)
  );

-- A cache hit never reached a provider, so it cannot have failed at one and it
-- cannot have burned tokens. Without this, one mis-wired call site would make
-- the console's "saved by the cache" figure indistinguishable from real spend.
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_cached_calls_are_free"
  CHECK (
    NOT "cached"
    OR ("outcome" <> 'FAILED' AND "promptTokens" IS NULL AND "completionTokens" IS NULL AND "totalTokens" IS NULL)
  );
