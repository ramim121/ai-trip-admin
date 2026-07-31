-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "aiPromptsPerPeriod" INTEGER;

-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "id" UUID NOT NULL,
    "bucketKey" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rate_limit_buckets_windowStart_idx" ON "rate_limit_buckets"("windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_buckets_bucketKey_windowStart_key" ON "rate_limit_buckets"("bucketKey", "windowStart");

-- ─────────────────────────────────────────────────────────────────────────────
-- Entitlement hardening: data, not just shape.
--
-- prisma/seed.ts is idempotent by SKIPPING rows that already exist, so that a
-- price ops edited in the console survives a re-seed. That is the right rule and
-- it is also why the seed cannot repair anything: on every database that has
-- already been seeded, these plan rows keep the values they were created with.
-- The corrections below therefore live here, where they run exactly once.
-- ─────────────────────────────────────────────────────────────────────────────

-- Every existing plan predates the new column and would otherwise read NULL,
-- which means UNLIMITED — the null trap, applied to the one ceiling that bounds
-- AI spend. Backfilled to the same numbers prisma/seed.ts now creates: FREE's
-- monthly turn allowance, and fifteen turns per included itinerary above it.
UPDATE "plans" SET "aiPromptsPerPeriod" = 30   WHERE "code" = 'FREE'          AND "aiPromptsPerPeriod" IS NULL;
UPDATE "plans" SET "aiPromptsPerPeriod" = 30   WHERE "code" = 'UNLOCK_SINGLE' AND "aiPromptsPerPeriod" IS NULL;
UPDATE "plans" SET "aiPromptsPerPeriod" = 150  WHERE "code" = 'PREMIUM_10'    AND "aiPromptsPerPeriod" IS NULL;
UPDATE "plans" SET "aiPromptsPerPeriod" = 750  WHERE "code" = 'PREMIUM_50'    AND "aiPromptsPerPeriod" IS NULL;
UPDATE "plans" SET "aiPromptsPerPeriod" = 1500 WHERE "code" = 'PREMIUM_100'   AND "aiPromptsPerPeriod" IS NULL;

-- Any other plan row — one an admin added, one a later migration invented —
-- lands on the floor rather than on "unlimited".
UPDATE "plans" SET "aiPromptsPerPeriod" = 30 WHERE "aiPromptsPerPeriod" IS NULL;

-- UNLOCK_SINGLE was seeded with all three limits NULL, i.e. unlimited, and with
-- sortOrder 1, which outranks FREE in the entitlement tie-break. It is not a
-- tier: the grant it sells is carried by the ItineraryUnlock row against one
-- itinerary. The nulls bought nothing and armed a landmine for the unbuilt
-- checkout — create a Subscription from the planCode `unlockOffer` already
-- publishes to clients, and one 200 BDT purchase became a permanent
-- account-wide grant of unlimited days AND unlimited saves. FREE's numbers here;
-- the `interval <> 'NONE'` clause now in every subscription lookup is the lock
-- on the same door that does not depend on this row being right.
UPDATE "plans"
   SET "maxSavedItineraries" = COALESCE("maxSavedItineraries", 3),
       "maxItineraryDays"    = COALESCE("maxItineraryDays", 2)
 WHERE "code" = 'UNLOCK_SINGLE';

-- The new ceiling joins the others under the existing non-negative rule. A
-- negative allowance is not "no allowance": it is a comparison that behaves
-- unpredictably at every call site that dutifully tests for null first.
ALTER TABLE "plans" DROP CONSTRAINT IF EXISTS "plans_limits_non_negative";

ALTER TABLE "plans"
  ADD CONSTRAINT "plans_limits_non_negative"
  CHECK (
    ("maxSavedItineraries" IS NULL OR "maxSavedItineraries" >= 0)
    AND ("maxItineraryDays" IS NULL OR "maxItineraryDays" >= 0)
    AND ("itinerariesPerPeriod" IS NULL OR "itinerariesPerPeriod" >= 0)
    AND ("aiPromptsPerPeriod" IS NULL OR "aiPromptsPerPeriod" >= 0)
  );
