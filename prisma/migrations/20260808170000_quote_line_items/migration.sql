-- What ops actually types when pricing a plan, line by line.
--
-- A quote revision has carried only totals. That is enough for a package with a
-- fixed price and not enough for a bespoke trip, where the whole point of the
-- exercise is that somebody looks at each thing the traveller asked for and says
-- what it really costs and who really supplies it.
--
-- THE LINE IS WHERE THE TWO PLANS MEET. `journeyItemId` points back at the item
-- the traveller placed, so the side-by-side comparison is a join rather than a
-- guess about which row corresponds to which. It is nullable because ops adds
-- lines nobody planned — a visa fee, an airport transfer, insurance — and
-- because deleting an item must not delete the money conversation about it.

CREATE TABLE "quote_line_items" (
    "id" UUID NOT NULL,
    "quoteRevisionId" UUID NOT NULL,

    -- The traveller's item this prices, when it prices one.
    "journeyItemId" UUID,

    -- Who actually supplies it. THE THING THE TRAVELLER COULD NOT KNOW: their
    -- plan says "beachfront hotel near the centre", and this says which hotel.
    "vendorName" TEXT,

    -- What ops is charging for, in their words. Seeded from the item's title so
    -- a line is never blank.
    "label" TEXT NOT NULL,
    "detail" TEXT,

    -- Whole taka, and a real price rather than a range. The estimate was the
    -- traveller's; this is ours, and a range here would only move the
    -- uncertainty onto the customer.
    "priceBdt" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quote_line_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "quote_line_items_quoteRevisionId_sortOrder_idx"
  ON "quote_line_items"("quoteRevisionId", "sortOrder");
CREATE INDEX "quote_line_items_journeyItemId_idx" ON "quote_line_items"("journeyItemId");

-- Cascade: a revision's lines are part of the revision.
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_quoteRevisionId_fkey"
  FOREIGN KEY ("quoteRevisionId") REFERENCES "quote_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull: the traveller may delete an item after being quoted for it. The line
-- survives, because what we charged is a fact about the quote rather than about
-- the plan it came from.
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_journeyItemId_fkey"
  FOREIGN KEY ("journeyItemId") REFERENCES "journey_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A line says something and costs something.
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_is_legible"
  CHECK (btrim("label") <> '' AND "priceBdt" >= 0 AND "quantity" > 0);

-- One line per item per revision.
--
-- Two lines against the same planned item would double-count it in the total and
-- render twice in the comparison, with no way to tell which was meant. Ops adds
-- an unrelated extra by leaving journeyItemId null, and the partial index leaves
-- those alone.
CREATE UNIQUE INDEX "quote_line_items_one_per_item_per_revision"
  ON "quote_line_items" ("quoteRevisionId", "journeyItemId")
  WHERE "journeyItemId" IS NOT NULL;

-- A sent revision is frozen, and that has to include its lines.
--
-- The existing trigger freezes the revision row. Without this one the totals a
-- traveller was shown would stay fixed while the lines behind them could be
-- rewritten — so the quote would still say 84,000 taka and no longer say what
-- for. A correction is a new version, exactly as it is for the revision itself.
CREATE OR REPLACE FUNCTION "quote_line_frozen_once_sent"() RETURNS TRIGGER AS $$
DECLARE
  sent_at TIMESTAMP(3);
  revision UUID;
BEGIN
  revision := COALESCE(NEW."quoteRevisionId", OLD."quoteRevisionId");

  SELECT "sentAt" INTO sent_at FROM "quote_revisions" WHERE "id" = revision;

  IF sent_at IS NOT NULL THEN
    RAISE EXCEPTION 'quote revision % has been sent; its lines cannot change — create a new version',
      revision USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "quote_line_items_frozen_once_sent"
  BEFORE INSERT OR UPDATE OR DELETE ON "quote_line_items"
  FOR EACH ROW EXECUTE FUNCTION "quote_line_frozen_once_sent"();
