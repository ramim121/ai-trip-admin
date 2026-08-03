-- Google Places imports, staged for human review before they can be sold.
--
-- The separation from `activities` is the security property, not a workflow
-- nicety: `itinerary_blocks.activityId` has a foreign key into `activities`, so
-- a row that lives only here is structurally incapable of appearing in
-- somebody's trip. Approval INSERTS into `activities`; it never flips a flag.

CREATE TYPE "PlaceCandidateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "place_candidates" (
    "id" UUID NOT NULL,
    "googlePlaceId" TEXT NOT NULL,
    "destinationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "formattedAddress" TEXT,
    "googleTypes" TEXT[],
    "rating" DECIMAL(2,1),
    "userRatingCount" INTEGER,
    "priceLevel" TEXT,
    "websiteUri" TEXT,
    "googleMapsUri" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "openingHoursText" TEXT,
    "searchQuery" TEXT NOT NULL,
    "status" "PlaceCandidateStatus" NOT NULL DEFAULT 'PENDING',
    "rejectedReason" TEXT,
    "activityId" UUID,
    "reviewedByAdminId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "place_candidates_pkey" PRIMARY KEY ("id")
);

-- One row per Google place, and this is what makes a REJECTION STICK. Without
-- it, re-running the same search would re-import something a curator has
-- already turned down, and the queue would fill with the same refusals every
-- time somebody searched.
CREATE UNIQUE INDEX "place_candidates_googlePlaceId_key" ON "place_candidates"("googlePlaceId");

-- One candidate per activity, so "where did this come from" has one answer.
CREATE UNIQUE INDEX "place_candidates_activityId_key" ON "place_candidates"("activityId");

CREATE INDEX "place_candidates_status_importedAt_idx" ON "place_candidates"("status", "importedAt");
CREATE INDEX "place_candidates_destinationId_status_idx" ON "place_candidates"("destinationId", "status");

ALTER TABLE "place_candidates" ADD CONSTRAINT "place_candidates_destinationId_fkey"
  FOREIGN KEY ("destinationId") REFERENCES "destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "place_candidates" ADD CONSTRAINT "place_candidates_activityId_fkey"
  FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "place_candidates" ADD CONSTRAINT "place_candidates_reviewedByAdminId_fkey"
  FOREIGN KEY ("reviewedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A decision has to be attributable and dated.
--
-- Approving or rejecting without recording who and when leaves "why is this in
-- the catalogue" unanswerable, which is the question a curation step exists to
-- answer in the first place.
ALTER TABLE "place_candidates" ADD CONSTRAINT "place_candidates_decision_is_attributed"
  CHECK (
    "status" = 'PENDING'
    OR ("reviewedAt" IS NOT NULL)
  );

-- An approval points at the activity it produced; a rejection never does.
--
-- The activityId is nullable because PENDING and REJECTED rows have none. This
-- stops the third state — APPROVED with nothing to show for it — which would be
-- a curator believing they had published something that does not exist.
ALTER TABLE "place_candidates" ADD CONSTRAINT "place_candidates_approved_has_activity"
  CHECK (
    ("status" = 'APPROVED' AND "activityId" IS NOT NULL)
    OR ("status" <> 'APPROVED' AND "activityId" IS NULL)
  );

-- A rejection says why. "We are not selling this" is a decision the next
-- curator has to be able to read rather than re-derive.
ALTER TABLE "place_candidates" ADD CONSTRAINT "place_candidates_rejection_has_reason"
  CHECK (
    "status" <> 'REJECTED'
    OR ("rejectedReason" IS NOT NULL AND btrim("rejectedReason") <> '')
  );
