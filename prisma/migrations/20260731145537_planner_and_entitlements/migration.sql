-- CreateEnum
CREATE TYPE "PlanCode" AS ENUM ('FREE', 'UNLOCK_SINGLE', 'PREMIUM_10', 'PREMIUM_50', 'PREMIUM_100');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('NONE', 'MONTHLY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('BKASH', 'SSLCOMMERZ', 'MANUAL_BANK');

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('ITINERARY_UNLOCK', 'SUBSCRIPTION', 'BOOKING');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ActivityCategory" AS ENUM ('SIGHTSEEING', 'ADVENTURE', 'WATER_SPORTS', 'CULTURE', 'FOOD', 'WELLNESS', 'NIGHTLIFE', 'SHOPPING', 'NATURE', 'TRANSPORT');

-- CreateEnum
CREATE TYPE "TimeOfDay" AS ENUM ('ANY', 'EARLY_MORNING', 'MORNING', 'AFTERNOON', 'EVENING', 'NIGHT');

-- CreateEnum
CREATE TYPE "ActivityIntensity" AS ENUM ('RELAXED', 'MODERATE', 'ACTIVE');

-- CreateEnum
CREATE TYPE "PlannerSessionStatus" AS ENUM ('ACTIVE', 'CONVERTED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "PlannerMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM', 'TOOL');

-- CreateEnum
CREATE TYPE "TripPurpose" AS ENUM ('VACATION', 'BUSINESS', 'HONEYMOON', 'FAMILY', 'SOLO', 'GROUP', 'OTHER');

-- CreateEnum
CREATE TYPE "TripPace" AS ENUM ('RELAXED', 'BALANCED', 'PACKED');

-- CreateEnum
CREATE TYPE "TransportPreference" AS ENUM ('PRIVATE_CAR', 'SELF_DRIVE', 'PUBLIC_TRANSIT', 'WALKING', 'MIXED');

-- CreateEnum
CREATE TYPE "BudgetBand" AS ENUM ('BUDGET', 'MID_RANGE', 'PREMIUM', 'LUXURY');

-- CreateEnum
CREATE TYPE "ItineraryStatus" AS ENUM ('DRAFT', 'SAVED', 'SUBMITTED', 'QUOTED', 'ACCEPTED', 'BOOKED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ItineraryBlockKind" AS ENUM ('ACTIVITY', 'TRANSIT', 'MEAL', 'REST', 'FREE', 'ACCOMMODATION');

-- CreateEnum
CREATE TYPE "TransitMode" AS ENUM ('WALK', 'CAR', 'TAXI', 'RIDESHARE', 'BUS', 'TRAIN', 'FERRY', 'BOAT', 'FLIGHT', 'BICYCLE');

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" "PlanCode" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priceBdt" INTEGER NOT NULL,
    "interval" "BillingInterval" NOT NULL DEFAULT 'NONE',
    "maxSavedItineraries" INTEGER,
    "maxItineraryDays" INTEGER,
    "itinerariesPerPeriod" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "paymentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "itinerary_unlocks" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "itineraryId" UUID NOT NULL,
    "paymentId" UUID,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "itinerary_unlocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counters" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "itinerariesCreated" INTEGER NOT NULL DEFAULT 0,
    "aiPromptsUsed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "provider" "PaymentProvider" NOT NULL,
    "purpose" "PaymentPurpose" NOT NULL,
    "amountBdt" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "providerRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anonymous_visitors" (
    "id" UUID NOT NULL,
    "cookieId" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "fingerprintHash" TEXT NOT NULL,
    "promptsUsed" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "convertedUserId" UUID,

    CONSTRAINT "anonymous_visitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teaser_cache" (
    "id" UUID NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHitAt" TIMESTAMP(3),

    CONSTRAINT "teaser_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "destinations" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "region" TEXT,
    "summary" TEXT NOT NULL,
    "heroImageUrl" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "timezone" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "destinationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "ActivityCategory" NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "pricePerPersonBdt" INTEGER,
    "priceNote" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "bestTimeOfDay" "TimeOfDay" NOT NULL DEFAULT 'ANY',
    "minPartySize" INTEGER,
    "maxPartySize" INTEGER,
    "intensity" "ActivityIntensity" NOT NULL DEFAULT 'MODERATE',
    "bookingRequired" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_images" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "alt" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_tags" (
    "activityId" UUID NOT NULL,
    "tagId" UUID NOT NULL,

    CONSTRAINT "activity_tags_pkey" PRIMARY KEY ("activityId","tagId")
);

-- CreateTable
CREATE TABLE "activity_opening_hours" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "opensMinute" INTEGER NOT NULL,
    "closesMinute" INTEGER NOT NULL,

    CONSTRAINT "activity_opening_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planner_sessions" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "anonymousVisitorId" UUID,
    "status" "PlannerSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "tripBrief" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planner_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planner_messages" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "role" "PlannerMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "model" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planner_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "itineraries" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "plannerSessionId" UUID,
    "title" TEXT NOT NULL,
    "destinationId" UUID,
    "destinationLabel" TEXT NOT NULL,
    "startDate" DATE,
    "endDate" DATE,
    "totalDays" INTEGER NOT NULL,
    "partySize" INTEGER NOT NULL,
    "purpose" "TripPurpose" NOT NULL DEFAULT 'VACATION',
    "pace" "TripPace" NOT NULL DEFAULT 'BALANCED',
    "transportPreference" "TransportPreference" NOT NULL DEFAULT 'MIXED',
    "budgetBand" "BudgetBand",
    "status" "ItineraryStatus" NOT NULL DEFAULT 'DRAFT',
    "isFullyUnlocked" BOOLEAN NOT NULL DEFAULT false,
    "coverImageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "itineraries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "itinerary_days" (
    "id" UUID NOT NULL,
    "itineraryId" UUID NOT NULL,
    "dayNumber" INTEGER NOT NULL,
    "date" DATE,
    "title" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "itinerary_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "itinerary_blocks" (
    "id" UUID NOT NULL,
    "dayId" UUID NOT NULL,
    "kind" "ItineraryBlockKind" NOT NULL,
    "activityId" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "transitMode" "TransitMode",
    "transitFromBlockId" UUID,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "costBdt" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "itinerary_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE INDEX "plans_isActive_sortOrder_idx" ON "plans"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_paymentId_key" ON "subscriptions"("paymentId");

-- CreateIndex
CREATE INDEX "subscriptions_userId_status_idx" ON "subscriptions"("userId", "status");

-- CreateIndex
CREATE INDEX "subscriptions_currentPeriodEnd_idx" ON "subscriptions"("currentPeriodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "itinerary_unlocks_paymentId_key" ON "itinerary_unlocks"("paymentId");

-- CreateIndex
CREATE INDEX "itinerary_unlocks_itineraryId_idx" ON "itinerary_unlocks"("itineraryId");

-- CreateIndex
CREATE UNIQUE INDEX "itinerary_unlocks_userId_itineraryId_key" ON "itinerary_unlocks"("userId", "itineraryId");

-- CreateIndex
CREATE INDEX "usage_counters_userId_periodEnd_idx" ON "usage_counters"("userId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "usage_counters_userId_periodStart_key" ON "usage_counters"("userId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotencyKey_key" ON "payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payments_userId_status_idx" ON "payments"("userId", "status");

-- CreateIndex
CREATE INDEX "payments_provider_providerRef_idx" ON "payments"("provider", "providerRef");

-- CreateIndex
CREATE INDEX "payments_status_createdAt_idx" ON "payments"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "anonymous_visitors_cookieId_key" ON "anonymous_visitors"("cookieId");

-- CreateIndex
CREATE INDEX "anonymous_visitors_ipHash_idx" ON "anonymous_visitors"("ipHash");

-- CreateIndex
CREATE INDEX "anonymous_visitors_fingerprintHash_idx" ON "anonymous_visitors"("fingerprintHash");

-- CreateIndex
CREATE INDEX "anonymous_visitors_convertedUserId_idx" ON "anonymous_visitors"("convertedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "teaser_cache_cacheKey_key" ON "teaser_cache"("cacheKey");

-- CreateIndex
CREATE INDEX "teaser_cache_hitCount_idx" ON "teaser_cache"("hitCount");

-- CreateIndex
CREATE UNIQUE INDEX "destinations_slug_key" ON "destinations"("slug");

-- CreateIndex
CREATE INDEX "destinations_isActive_sortOrder_idx" ON "destinations"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "destinations_country_idx" ON "destinations"("country");

-- CreateIndex
CREATE UNIQUE INDEX "activities_slug_key" ON "activities"("slug");

-- CreateIndex
CREATE INDEX "activities_destinationId_isActive_idx" ON "activities"("destinationId", "isActive");

-- CreateIndex
CREATE INDEX "activities_category_idx" ON "activities"("category");

-- CreateIndex
CREATE INDEX "activities_destinationId_category_isActive_idx" ON "activities"("destinationId", "category", "isActive");

-- CreateIndex
CREATE INDEX "activity_images_activityId_sortOrder_idx" ON "activity_images"("activityId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "tags_slug_key" ON "tags"("slug");

-- CreateIndex
CREATE INDEX "activity_tags_tagId_idx" ON "activity_tags"("tagId");

-- CreateIndex
CREATE INDEX "activity_opening_hours_activityId_dayOfWeek_idx" ON "activity_opening_hours"("activityId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "planner_sessions_userId_idx" ON "planner_sessions"("userId");

-- CreateIndex
CREATE INDEX "planner_sessions_anonymousVisitorId_idx" ON "planner_sessions"("anonymousVisitorId");

-- CreateIndex
CREATE INDEX "planner_sessions_status_lastMessageAt_idx" ON "planner_sessions"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "planner_messages_sessionId_createdAt_idx" ON "planner_messages"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "itineraries_userId_status_idx" ON "itineraries"("userId", "status");

-- CreateIndex
CREATE INDEX "itineraries_destinationId_idx" ON "itineraries"("destinationId");

-- CreateIndex
CREATE INDEX "itineraries_plannerSessionId_idx" ON "itineraries"("plannerSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "itinerary_days_itineraryId_dayNumber_key" ON "itinerary_days"("itineraryId", "dayNumber");

-- CreateIndex
CREATE INDEX "itinerary_blocks_dayId_startMinute_idx" ON "itinerary_blocks"("dayId", "startMinute");

-- CreateIndex
CREATE INDEX "itinerary_blocks_activityId_idx" ON "itinerary_blocks"("activityId");

-- CreateIndex
CREATE INDEX "itinerary_blocks_transitFromBlockId_idx" ON "itinerary_blocks"("transitFromBlockId");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itinerary_unlocks" ADD CONSTRAINT "itinerary_unlocks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itinerary_unlocks" ADD CONSTRAINT "itinerary_unlocks_itineraryId_fkey" FOREIGN KEY ("itineraryId") REFERENCES "itineraries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itinerary_unlocks" ADD CONSTRAINT "itinerary_unlocks_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anonymous_visitors" ADD CONSTRAINT "anonymous_visitors_convertedUserId_fkey" FOREIGN KEY ("convertedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_images" ADD CONSTRAINT "activity_images_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_tags" ADD CONSTRAINT "activity_tags_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_tags" ADD CONSTRAINT "activity_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_opening_hours" ADD CONSTRAINT "activity_opening_hours_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planner_sessions" ADD CONSTRAINT "planner_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planner_sessions" ADD CONSTRAINT "planner_sessions_anonymousVisitorId_fkey" FOREIGN KEY ("anonymousVisitorId") REFERENCES "anonymous_visitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planner_messages" ADD CONSTRAINT "planner_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "planner_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itineraries" ADD CONSTRAINT "itineraries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itineraries" ADD CONSTRAINT "itineraries_plannerSessionId_fkey" FOREIGN KEY ("plannerSessionId") REFERENCES "planner_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itineraries" ADD CONSTRAINT "itineraries_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itinerary_days" ADD CONSTRAINT "itinerary_days_itineraryId_fkey" FOREIGN KEY ("itineraryId") REFERENCES "itineraries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itinerary_blocks" ADD CONSTRAINT "itinerary_blocks_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "itinerary_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itinerary_blocks" ADD CONSTRAINT "itinerary_blocks_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itinerary_blocks" ADD CONSTRAINT "itinerary_blocks_transitFromBlockId_fkey" FOREIGN KEY ("transitFromBlockId") REFERENCES "itinerary_blocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Invariants Prisma's schema language cannot express.
--
-- These are enforced here rather than only in the service layer because a rule
-- that lives solely in application code is a convention, not a constraint: a
-- backfill script, an admin console mutation or a future agent bypasses it
-- silently. Prisma does not model CHECK constraints, so it neither drops them
-- on later migrations nor reports them as drift.
-- ─────────────────────────────────────────────────────────────────────────────

-- A planning session belongs to EXACTLY ONE of a user or an anonymous visitor.
-- Both set would let a logged-in user burn the anonymous quota; neither set
-- would orphan the conversation.
ALTER TABLE "planner_sessions"
  ADD CONSTRAINT "planner_sessions_single_owner"
  CHECK (("userId" IS NOT NULL) <> ("anonymousVisitorId" IS NOT NULL));

-- Minutes from local midnight. A block must start within the day and end after
-- it starts; the end may run past midnight (1560 = 02:00 next morning), which
-- is why the ceiling is 2880 rather than 1440. Zero-length and inverted blocks
-- break the Gantt and make overlap detection meaningless.
ALTER TABLE "itinerary_blocks"
  ADD CONSTRAINT "itinerary_blocks_minute_range"
  CHECK (
    "startMinute" >= 0
    AND "startMinute" < 1440
    AND "endMinute" > "startMinute"
    AND "endMinute" <= 2880
  );

-- Same minute domain for opening hours, so "is this activity open during this
-- block" stays pure integer comparison.
ALTER TABLE "activity_opening_hours"
  ADD CONSTRAINT "activity_opening_hours_valid_window"
  CHECK (
    "dayOfWeek" BETWEEN 0 AND 6
    AND "opensMinute" >= 0
    AND "opensMinute" < 1440
    AND "closesMinute" > "opensMinute"
    AND "closesMinute" <= 2880
  );

-- Money is whole BDT and never negative. A refund is a REFUNDED status on a
-- positive row, not a negative amount.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_non_negative" CHECK ("amountBdt" >= 0);

ALTER TABLE "plans"
  ADD CONSTRAINT "plans_price_non_negative" CHECK ("priceBdt" >= 0);

ALTER TABLE "itinerary_blocks"
  ADD CONSTRAINT "itinerary_blocks_cost_non_negative"
  CHECK ("costBdt" IS NULL OR "costBdt" >= 0);

ALTER TABLE "activities"
  ADD CONSTRAINT "activities_price_non_negative"
  CHECK ("pricePerPersonBdt" IS NULL OR "pricePerPersonBdt" >= 0);

-- A null plan limit means UNLIMITED; a negative one means nothing at all.
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_limits_non_negative"
  CHECK (
    ("maxSavedItineraries" IS NULL OR "maxSavedItineraries" >= 0)
    AND ("maxItineraryDays" IS NULL OR "maxItineraryDays" >= 0)
    AND ("itinerariesPerPeriod" IS NULL OR "itinerariesPerPeriod" >= 0)
  );

-- Trips have at least one day and one traveller; day numbers are 1-based.
ALTER TABLE "itineraries"
  ADD CONSTRAINT "itineraries_positive_scope"
  CHECK ("totalDays" >= 1 AND "partySize" >= 1);

ALTER TABLE "itinerary_days"
  ADD CONSTRAINT "itinerary_days_day_number_positive" CHECK ("dayNumber" >= 1);

-- An activity that takes no time cannot be scheduled.
ALTER TABLE "activities"
  ADD CONSTRAINT "activities_duration_positive" CHECK ("durationMinutes" > 0);

-- Party-size bounds must be orderable, or no group ever qualifies.
ALTER TABLE "activities"
  ADD CONSTRAINT "activities_party_size_range"
  CHECK (
    ("minPartySize" IS NULL OR "minPartySize" >= 1)
    AND ("maxPartySize" IS NULL OR "maxPartySize" >= 1)
    AND ("minPartySize" IS NULL OR "maxPartySize" IS NULL OR "maxPartySize" >= "minPartySize")
  );

-- Usage windows and billing periods must move forwards.
ALTER TABLE "usage_counters"
  ADD CONSTRAINT "usage_counters_period_ordered" CHECK ("periodEnd" > "periodStart");

ALTER TABLE "usage_counters"
  ADD CONSTRAINT "usage_counters_non_negative"
  CHECK ("itinerariesCreated" >= 0 AND "aiPromptsUsed" >= 0);

-- The anonymous quota is counted upwards from zero.
ALTER TABLE "anonymous_visitors"
  ADD CONSTRAINT "anonymous_visitors_prompts_non_negative" CHECK ("promptsUsed" >= 0);
