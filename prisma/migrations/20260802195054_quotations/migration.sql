-- Quotations: a traveller asks what a trip would cost, ops prices it, they decide.
--
-- THREE THINGS HERE CANNOT BE EXPRESSED IN THE PRISMA SCHEMA, and each is the
-- difference between a rule and a habit.
--
--   1. `total = subtotal - discount`, as a CHECK. Same discipline as
--      package_bookings_totals_add_up: an amount somebody will be charged is
--      not something a service layer should be trusted to keep consistent.
--
--   2. ONE OPEN QUOTE PER ITINERARY, as a partial unique index. Prisma cannot
--      express `WHERE status IN (...)`, and a plain unique would forbid a
--      second quote even after the first was declined a year ago.
--
--   3. A SENT REVISION IS IMMUTABLE, as a trigger. Every service write already
--      carries `sentAt IS NULL` in its WHERE clause, but a predicate somebody
--      forgets to write is not a rule — and the thing being protected is a
--      price a traveller has already been shown and may have decided on.

CREATE TYPE "QuoteStatus" AS ENUM (
  'REQUESTED', 'PRICED', 'SENT', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED'
);

CREATE TABLE "quotes" (
  "id"            UUID NOT NULL,
  -- Nullable + SetNull on both FKs, exactly like payments.userId. A quote is a
  -- commercial record; deleting the account or the trip must not erase what was
  -- offered and for how much.
  "userId"        UUID,
  "itineraryId"   UUID,
  "status"        "QuoteStatus" NOT NULL DEFAULT 'REQUESTED',
  "travellerNote" TEXT,
  "requestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt"     TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "quotes" ADD CONSTRAINT "quotes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "quotes" ADD CONSTRAINT "quotes_itineraryId_fkey"
  FOREIGN KEY ("itineraryId") REFERENCES "itineraries" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "quotes_status_requestedAt_idx" ON "quotes" ("status", "requestedAt");
CREATE INDEX "quotes_userId_idx" ON "quotes" ("userId");

-- One conversation at a time per trip. A second request while one is open is
-- the same conversation; a request after a decline is a new one.
CREATE UNIQUE INDEX "quotes_one_open_per_itinerary"
  ON "quotes" ("itineraryId")
  WHERE "status" IN ('REQUESTED', 'PRICED', 'SENT') AND "itineraryId" IS NOT NULL;

CREATE TABLE "quote_revisions" (
  "id"               UUID NOT NULL,
  "quoteId"          UUID NOT NULL,
  "version"          INTEGER NOT NULL,
  "subtotalBdt"      INTEGER NOT NULL,
  "discountBdt"      INTEGER NOT NULL DEFAULT 0,
  "totalBdt"         INTEGER NOT NULL,
  "inclusions"       TEXT[],
  "exclusions"       TEXT[],
  "terms"            TEXT,
  "travellerMessage" TEXT,
  "validUntil"       TIMESTAMP(3),
  "sentAt"           TIMESTAMP(3),
  "pricedByAdminId"  UUID,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "quote_revisions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "quote_revisions" ADD CONSTRAINT "quote_revisions_quoteId_fkey"
  FOREIGN KEY ("quoteId") REFERENCES "quotes" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "quote_revisions_quoteId_version_key"
  ON "quote_revisions" ("quoteId", "version");
CREATE INDEX "quote_revisions_quoteId_sentAt_idx"
  ON "quote_revisions" ("quoteId", "sentAt");

-- The arithmetic, enforced where it cannot be forgotten.
ALTER TABLE "quote_revisions" ADD CONSTRAINT "quote_revisions_totals_add_up"
  CHECK (
    "subtotalBdt" >= 0
    AND "discountBdt" >= 0
    AND "discountBdt" <= "subtotalBdt"
    AND "totalBdt" = "subtotalBdt" - "discountBdt"
  );

ALTER TABLE "quote_revisions" ADD CONSTRAINT "quote_revisions_version_positive"
  CHECK ("version" >= 1);

-- A sent revision is frozen.
--
-- Only `updatedAt` may move, so an ORM that touches it on every write does not
-- trip the guard. Everything a traveller was shown — the numbers, the validity,
-- what is included, the message — is refused. Ops changing a sent price writes
-- a new version instead, which is the whole reason versions exist.
CREATE OR REPLACE FUNCTION "quote_revision_frozen_once_sent"() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."sentAt" IS NOT NULL AND (
       NEW."subtotalBdt"      IS DISTINCT FROM OLD."subtotalBdt"
    OR NEW."discountBdt"      IS DISTINCT FROM OLD."discountBdt"
    OR NEW."totalBdt"         IS DISTINCT FROM OLD."totalBdt"
    OR NEW."inclusions"       IS DISTINCT FROM OLD."inclusions"
    OR NEW."exclusions"       IS DISTINCT FROM OLD."exclusions"
    OR NEW."terms"            IS DISTINCT FROM OLD."terms"
    OR NEW."travellerMessage" IS DISTINCT FROM OLD."travellerMessage"
    OR NEW."validUntil"       IS DISTINCT FROM OLD."validUntil"
    OR NEW."sentAt"           IS DISTINCT FROM OLD."sentAt"
  ) THEN
    RAISE EXCEPTION
      'quote revision % has been sent and cannot be changed; create a new version',
      OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "quote_revisions_frozen_once_sent"
  BEFORE UPDATE ON "quote_revisions"
  FOR EACH ROW EXECUTE FUNCTION "quote_revision_frozen_once_sent"();
