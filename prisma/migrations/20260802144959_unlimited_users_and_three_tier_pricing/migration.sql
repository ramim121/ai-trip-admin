-- Unlimited accounts, and a three-tier price list.
--
-- TWO CHANGES THAT LOOK UNRELATED AND ARE NOT. Both narrow what the product
-- meters. `users.unlimited` exempts one account from every ceiling; dropping
-- UNLOCK_SINGLE removes the only product that granted access to a single
-- itinerary rather than to a period of them. Afterwards there is exactly one
-- shape of entitlement — a plan, for a period — plus a per-user exemption.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A CHECK CONSTRAINT PINS THE ENUM TYPE, AND THAT IS WHAT BROKE THE FIRST RUN
--
-- `payments_booking_target_matches_purpose` was created as
--   CHECK ("bookingId" IS NULL OR "purpose" = 'BOOKING')
-- and Postgres stored that literal as `'BOOKING'::"PaymentPurpose"`, resolved
-- to the type as it existed then. Renaming the type does not rewrite the
-- constraint — it now reads `'BOOKING'::"PaymentPurpose_old"`, so retyping the
-- column fails with
--   operator does not exist: "PaymentPurpose" = "PaymentPurpose_old"
-- which names the two types without ever mentioning the constraint holding the
-- stale one. The constraint must therefore be dropped BEFORE the retype and
-- recreated after, against the new type.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EVERY STEP IS IDEMPOTENT, ON PURPOSE
--
-- The first attempt applied roughly half of this before failing, leaving the
-- database with the new column, the tables already dropped, and the enum
-- mid-swap. A migration that only works from a clean schema would need that
-- state unpicked by hand first. These statements are written so that running
-- them against the half-applied database and against a fresh one both converge
-- on the same result, which is the property that actually makes a failed
-- migration recoverable.
--
-- ORDER IS STILL LOAD-BEARING: rows carrying a doomed enum value must be gone
-- before the type is narrowed. Verified against the live database first —
-- 0 payments against any plan, 0 itinerary_unlocks, payments.purpose holding
-- only BOOKING — so the DELETE below is the precondition for the ALTER TYPE
-- after it, not tidying-up.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Unlimited accounts ───────────────────────────────────────────────────
-- NOT NULL with a default, so every existing row stays metered exactly as it
-- was. The exemption is granted, never inherited.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "unlimited" BOOLEAN NOT NULL DEFAULT false;

-- ── 2. Retire the one-off unlock ────────────────────────────────────────────
-- The grant table goes first, because dropping it is what removes the last
-- reason for ITINERARY_UNLOCK to exist. `isFullyUnlocked` was a denormalised
-- cache OF that table; with the table gone it is a column nothing could ever
-- recompute, which is worse than absent.
DROP TABLE IF EXISTS "itinerary_unlocks";

ALTER TABLE "itineraries" DROP COLUMN IF EXISTS "isFullyUnlocked";

-- ── 3. Narrow PaymentPurpose ────────────────────────────────────────────────
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_booking_target_matches_purpose";

DO $$
BEGIN
  -- Skipped when a previous run already swapped the names.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentPurpose_old') THEN
    ALTER TYPE "PaymentPurpose" RENAME TO "PaymentPurpose_old";
    CREATE TYPE "PaymentPurpose" AS ENUM ('SUBSCRIPTION', 'BOOKING');
  END IF;
END $$;

ALTER TABLE "payments"
  ALTER COLUMN "purpose" TYPE "PaymentPurpose"
  USING ("purpose"::text::"PaymentPurpose");

DROP TYPE IF EXISTS "PaymentPurpose_old";

-- Recreated against the new type. Same rule as before: a payment may only name
-- a booking when that is what it is for.
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_target_matches_purpose"
  CHECK ("bookingId" IS NULL OR "purpose" = 'BOOKING');

-- ── 4. Narrow PlanCode to the three tiers actually on sale ──────────────────
-- PREMIUM_10 and PREMIUM_50 are deleted rather than renamed into PREMIUM_5. A
-- rename would carry the old row's price and limits forward under a new name,
-- and the new tier is neither of them: 5 itineraries at 500 BDT is its own
-- product. The seed inserts it, keeping one owner for what a plan contains.
DELETE FROM "plans" WHERE "code"::text IN ('UNLOCK_SINGLE', 'PREMIUM_10', 'PREMIUM_50');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PlanCode_old') THEN
    ALTER TYPE "PlanCode" RENAME TO "PlanCode_old";
    CREATE TYPE "PlanCode" AS ENUM ('FREE', 'PREMIUM_5', 'PREMIUM_100');
  END IF;
END $$;

ALTER TABLE "plans"
  ALTER COLUMN "code" TYPE "PlanCode"
  USING ("code"::text::"PlanCode");

DROP TYPE IF EXISTS "PlanCode_old";
