-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "CouponType" AS ENUM ('PERCENT', 'FIXED');

-- DropForeignKey
-- REMOVED, for the second time. See the note in the past-trips migration.
--
-- `migrate dev` proposed:
--   ALTER TABLE "poll_votes" DROP CONSTRAINT "poll_votes_option_belongs_to_poll";
--
-- That constraint is what stops a vote being recorded against another poll's
-- option. Prisma schema cannot express a composite foreign key, so every future
-- diff reads it as drift and proposes the same drop. Delete the line, every
-- time.
SELECT 1;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "bookingId" UUID;

-- CreateTable
CREATE TABLE "package_bookings" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "userId" UUID,
    "packageId" UUID NOT NULL,
    "departureId" UUID NOT NULL,
    "partySize" INTEGER NOT NULL,
    "unitPriceBdt" INTEGER NOT NULL,
    "subtotalBdt" INTEGER NOT NULL,
    "discountBdt" INTEGER NOT NULL DEFAULT 0,
    "totalBdt" INTEGER NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "notes" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "package_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "type" "CouponType" NOT NULL,
    "value" INTEGER NOT NULL,
    "maxDiscountBdt" INTEGER,
    "minSpendBdt" INTEGER,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "maxRedemptions" INTEGER,
    "maxPerUser" INTEGER NOT NULL DEFAULT 1,
    "redeemedCount" INTEGER NOT NULL DEFAULT 0,
    "packageId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_redemptions" (
    "id" UUID NOT NULL,
    "couponId" UUID NOT NULL,
    "userId" UUID,
    "bookingId" UUID NOT NULL,
    "discountBdt" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "package_bookings_reference_key" ON "package_bookings"("reference");

-- CreateIndex
CREATE INDEX "package_bookings_userId_status_idx" ON "package_bookings"("userId", "status");

-- CreateIndex
CREATE INDEX "package_bookings_departureId_status_idx" ON "package_bookings"("departureId", "status");

-- CreateIndex
CREATE INDEX "package_bookings_status_createdAt_idx" ON "package_bookings"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE INDEX "coupons_isActive_endsAt_idx" ON "coupons"("isActive", "endsAt");

-- CreateIndex
CREATE INDEX "coupons_packageId_idx" ON "coupons"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_redemptions_bookingId_key" ON "coupon_redemptions"("bookingId");

-- CreateIndex
CREATE INDEX "coupon_redemptions_couponId_userId_idx" ON "coupon_redemptions"("couponId", "userId");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "package_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_bookings" ADD CONSTRAINT "package_bookings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_bookings" ADD CONSTRAINT "package_bookings_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "travel_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_bookings" ADD CONSTRAINT "package_bookings_departureId_fkey" FOREIGN KEY ("departureId") REFERENCES "package_departures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "travel_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "package_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Invariants Prisma cannot express.
--
-- The arithmetic ones are the point of this block. Every other layer computes
-- these totals; this is the layer that refuses to store one that does not add
-- up. A booking whose `totalBdt` disagrees with its own subtotal and discount is
-- a number somebody will eventually be charged, and no amount of care in a
-- service prevents a hand-written UPDATE during an incident.
-- ─────────────────────────────────────────────────────────────────────────────

-- A party of nobody is not a booking.
ALTER TABLE "package_bookings" ADD CONSTRAINT "package_bookings_party_size_positive"
  CHECK ("partySize" >= 1);

-- The money adds up, or it is not stored.
--
-- `subtotal = unit * party` and `total = subtotal - discount`, exactly. Not
-- "approximately", and not "the service takes care of it".
ALTER TABLE "package_bookings" ADD CONSTRAINT "package_bookings_totals_add_up"
  CHECK (
    "unitPriceBdt" >= 0
    AND "subtotalBdt" = "unitPriceBdt" * "partySize"
    AND "discountBdt" >= 0
    AND "discountBdt" <= "subtotalBdt"
    AND "totalBdt" = "subtotalBdt" - "discountBdt"
  );

-- Lowercased before write, like every other email column. The CHECK is what
-- makes that a guarantee rather than a habit.
ALTER TABLE "package_bookings" ADD CONSTRAINT "package_bookings_email_normalised"
  CHECK ("contactEmail" = lower(btrim("contactEmail")));

-- A status and its timestamp agree.
--
-- CONFIRMED with no `confirmedAt` is a booking nobody can date, and "when did
-- this become confirmed" is the first question asked when a traveller and the
-- system disagree. Same for a cancellation.
ALTER TABLE "package_bookings" ADD CONSTRAINT "package_bookings_status_has_its_timestamp"
  CHECK (
    ("status" <> 'CONFIRMED' OR "confirmedAt" IS NOT NULL)
    AND ("status" NOT IN ('CANCELLED', 'REFUNDED') OR "cancelledAt" IS NOT NULL)
  );

-- The reference is what a traveller reads down a phone line.
ALTER TABLE "package_bookings" ADD CONSTRAINT "package_bookings_reference_present"
  CHECK (btrim("reference") <> '');

-- Uppercase, always.
--
-- The lookup is an exact match, so a lowercase row is a code that exists and can
-- never be redeemed — surfacing as "your coupon does not work" for a code ops
-- can see sitting in the console. Normalising on write is the rule; this makes
-- it true of rows written by anything else.
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_code_is_uppercase"
  CHECK ("code" = upper(btrim("code")) AND btrim("code") <> '');

-- A percentage is a percentage; taka are taka.
--
-- A PERCENT coupon with `value = 5000` would take 5,000% off — which the totals
-- constraint above would then reject at booking time, i.e. as a 500 rather than
-- as a coupon that could never have been created.
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_value_matches_type"
  CHECK (
    ("type" = 'PERCENT' AND "value" BETWEEN 1 AND 100)
    OR ("type" = 'FIXED' AND "value" > 0)
  );

-- A cap only means something on a percentage. On a FIXED coupon the value IS the
-- cap, and a second one is a number nobody reads.
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_cap_only_on_percent"
  CHECK ("maxDiscountBdt" IS NULL OR ("type" = 'PERCENT' AND "maxDiscountBdt" > 0));

ALTER TABLE "coupons" ADD CONSTRAINT "coupons_limits_positive"
  CHECK (
    ("minSpendBdt" IS NULL OR "minSpendBdt" >= 0)
    AND ("maxRedemptions" IS NULL OR "maxRedemptions" > 0)
    AND "maxPerUser" > 0
    AND "redeemedCount" >= 0
  );

ALTER TABLE "coupons" ADD CONSTRAINT "coupons_window_ordered"
  CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt");

-- A redemption that gave nothing away should not exist — it consumed a ceiling
-- for no benefit, which is the shape of a bug rather than of a discount.
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_discount_positive"
  CHECK ("discountBdt" > 0);

-- A payment for a booking points at one; a payment for anything else does not.
--
-- Without this, `bookingId` could be set on a SUBSCRIPTION payment and the
-- settlement dispatch would confirm a booking nobody paid for under that
-- purpose. Same argument as the pricing-mode constraint on packages: a column
-- meaningful for only one value of an enum should be unset for the others, and
-- the database is where that stops being a convention.
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_target_matches_purpose"
  CHECK ("bookingId" IS NULL OR "purpose" = 'BOOKING');
