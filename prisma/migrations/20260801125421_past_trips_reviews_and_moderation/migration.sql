-- CreateEnum
CREATE TYPE "PastTripStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TripHighlightKind" AS ENUM ('MOMENT', 'INCIDENT', 'MILESTONE');

-- CreateEnum
CREATE TYPE "ReviewDimension" AS ENUM ('ORGANISATION', 'ACCOMMODATION', 'FOOD', 'TRANSPORT', 'VALUE_FOR_MONEY', 'TRIP_LEADER', 'ACTIVITIES');

-- CreateEnum
CREATE TYPE "ModerationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- REMOVED BY HAND, and worth reading before regenerating a migration.
--
-- `prisma migrate dev` proposed dropping two things here:
--
--   ALTER TABLE "poll_votes" DROP CONSTRAINT "poll_votes_option_belongs_to_poll";
--   DROP INDEX "poll_options_id_pollId_key";
--
-- Both were added deliberately in the previous migration, and together they are
-- what stops a vote being recorded against another poll's option. The diff
-- proposes removing them because it compares the database against the schema
-- file, and a COMPOSITE FOREIGN KEY is not expressible in Prisma schema — so
-- from the diff's point of view they are drift.
--
-- `@@unique([id, pollId])` has now been added to PollOption, which silences
-- half of it. The composite FK cannot be expressed at all, so a future
-- `migrate dev` will keep proposing that DROP: delete the line, every time.
-- Postgres refused it anyway, because the index backs the constraint — which is
-- why this migration failed on its first run instead of quietly removing an
-- integrity guarantee.

-- CreateTable
CREATE TABLE "past_trips" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "story" TEXT NOT NULL,
    "packageId" UUID,
    "departureId" UUID,
    "destinationLabel" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "scope" "PackageScope" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "memberCount" INTEGER NOT NULL,
    "heroImageUrl" TEXT,
    "status" "PastTripStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "past_trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "past_trip_leaders" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "leaderId" UUID NOT NULL,
    "role" "TripLeaderRole" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "past_trip_leaders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_participants" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "userId" UUID,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_highlights" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "kind" "TripHighlightKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "dayNumber" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_highlights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_media" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "alt" TEXT NOT NULL,
    "caption" TEXT,
    "uploadedByUserId" UUID,
    "moderationStatus" "ModerationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByAdminId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_reviews" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "headline" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "displayName" TEXT,
    "moderationStatus" "ModerationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByAdminId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trip_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_review_ratings" (
    "id" UUID NOT NULL,
    "reviewId" UUID NOT NULL,
    "dimension" "ReviewDimension" NOT NULL,
    "score" INTEGER NOT NULL,

    CONSTRAINT "trip_review_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "past_trips_slug_key" ON "past_trips"("slug");

-- CreateIndex
CREATE INDEX "past_trips_status_startDate_idx" ON "past_trips"("status", "startDate");

-- CreateIndex
CREATE INDEX "past_trips_packageId_idx" ON "past_trips"("packageId");

-- CreateIndex
CREATE INDEX "past_trip_leaders_leaderId_idx" ON "past_trip_leaders"("leaderId");

-- CreateIndex
CREATE UNIQUE INDEX "past_trip_leaders_tripId_leaderId_key" ON "past_trip_leaders"("tripId", "leaderId");

-- CreateIndex
CREATE INDEX "trip_participants_userId_idx" ON "trip_participants"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "trip_participants_tripId_email_key" ON "trip_participants"("tripId", "email");

-- CreateIndex
CREATE INDEX "trip_highlights_tripId_sortOrder_idx" ON "trip_highlights"("tripId", "sortOrder");

-- CreateIndex
CREATE INDEX "trip_media_tripId_moderationStatus_sortOrder_idx" ON "trip_media"("tripId", "moderationStatus", "sortOrder");

-- CreateIndex
CREATE INDEX "trip_media_moderationStatus_createdAt_idx" ON "trip_media"("moderationStatus", "createdAt");

-- CreateIndex
CREATE INDEX "trip_reviews_tripId_moderationStatus_idx" ON "trip_reviews"("tripId", "moderationStatus");

-- CreateIndex
CREATE INDEX "trip_reviews_moderationStatus_createdAt_idx" ON "trip_reviews"("moderationStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "trip_reviews_tripId_userId_key" ON "trip_reviews"("tripId", "userId");

-- CreateIndex
CREATE INDEX "trip_review_ratings_dimension_idx" ON "trip_review_ratings"("dimension");

-- CreateIndex
CREATE UNIQUE INDEX "trip_review_ratings_reviewId_dimension_key" ON "trip_review_ratings"("reviewId", "dimension");

-- AddForeignKey
ALTER TABLE "past_trips" ADD CONSTRAINT "past_trips_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "travel_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "past_trips" ADD CONSTRAINT "past_trips_departureId_fkey" FOREIGN KEY ("departureId") REFERENCES "package_departures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "past_trip_leaders" ADD CONSTRAINT "past_trip_leaders_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "past_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "past_trip_leaders" ADD CONSTRAINT "past_trip_leaders_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "trip_leaders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_participants" ADD CONSTRAINT "trip_participants_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "past_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_participants" ADD CONSTRAINT "trip_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_highlights" ADD CONSTRAINT "trip_highlights_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "past_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_media" ADD CONSTRAINT "trip_media_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "past_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_media" ADD CONSTRAINT "trip_media_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_media" ADD CONSTRAINT "trip_media_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_reviews" ADD CONSTRAINT "trip_reviews_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "past_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_reviews" ADD CONSTRAINT "trip_reviews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_reviews" ADD CONSTRAINT "trip_reviews_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_review_ratings" ADD CONSTRAINT "trip_review_ratings_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "trip_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Invariants Prisma cannot express.
--
-- Same argument as the Discover migration: the application is one writer among
-- several — a seed, a console form, a psql session during an incident — and a
-- rule only one of them honours is a rule the data will eventually break.
-- ─────────────────────────────────────────────────────────────────────────────

-- A trip that ended before it began, or that nobody went on.
--
-- `memberCount >= 1` matters because that number is printed on the public card
-- as "14 travellers". Zero would render as a trip we ran for nobody, which is
-- either a typo or a story we should be telling differently.
ALTER TABLE "past_trips" ADD CONSTRAINT "past_trips_dates_ordered"
  CHECK ("endDate" >= "startDate");

ALTER TABLE "past_trips" ADD CONSTRAINT "past_trips_member_count_positive"
  CHECK ("memberCount" >= 1);

-- Day 1 is the first day, not an index. Null means "ran through the trip".
ALTER TABLE "trip_highlights" ADD CONSTRAINT "trip_highlights_day_number_positive"
  CHECK ("dayNumber" IS NULL OR "dayNumber" >= 1);

-- Emails are lowercased before write, and the unique index on (tripId, email)
-- only deduplicates if every writer does it. This makes that a guarantee rather
-- than a habit.
ALTER TABLE "trip_participants" ADD CONSTRAINT "trip_participants_email_normalised"
  CHECK ("email" = lower(btrim("email")));

-- The scale. One to five, integers.
--
-- The most important constraint in this migration, because these numbers are
-- averaged and published. A 0 or an 11 from a client that sent an index instead
-- of a score would move a dimension's average and be invisible in the result —
-- an average is exactly the operation that hides an outlier.
ALTER TABLE "trip_review_ratings" ADD CONSTRAINT "trip_review_ratings_score_in_range"
  CHECK ("score" BETWEEN 1 AND 5);

-- Moderation decisions carry a decider.
--
-- A row that is APPROVED or REJECTED without `reviewedAt` is a decision nobody
-- can be asked about, and "how did this get onto the site" is a question that
-- gets asked precisely when the answer is uncomfortable. PENDING must have
-- neither: a timestamp on an undecided row is a half-written approval.
ALTER TABLE "trip_media" ADD CONSTRAINT "trip_media_moderation_is_attributable"
  CHECK (
    ("moderationStatus" = 'PENDING' AND "reviewedAt" IS NULL AND "reviewedByAdminId" IS NULL)
    OR ("moderationStatus" <> 'PENDING' AND "reviewedAt" IS NOT NULL)
  );

ALTER TABLE "trip_reviews" ADD CONSTRAINT "trip_reviews_moderation_is_attributable"
  CHECK (
    ("moderationStatus" = 'PENDING' AND "reviewedAt" IS NULL AND "reviewedByAdminId" IS NULL)
    OR ("moderationStatus" <> 'PENDING' AND "reviewedAt" IS NOT NULL)
  );

-- A published photograph has alt text.
--
-- Not "should have". An approved row IS what the public page renders, and an
-- empty alt across a gallery of twenty photographs is twenty unlabelled images
-- for anyone using a screen reader. PENDING rows are exempt so an upload can be
-- captioned during moderation rather than before it.
ALTER TABLE "trip_media" ADD CONSTRAINT "trip_media_approved_rows_have_alt"
  CHECK ("moderationStatus" <> 'APPROVED' OR btrim("alt") <> '');

-- A rejection says why.
--
-- The reason goes back to the uploader and is never published. Rejecting
-- without one leaves them with a photograph that vanished and no explanation,
-- which is how a moderation queue becomes a support queue.
ALTER TABLE "trip_media" ADD CONSTRAINT "trip_media_rejections_have_a_reason"
  CHECK ("moderationStatus" <> 'REJECTED' OR btrim(coalesce("rejectionReason", '')) <> '');

ALTER TABLE "trip_reviews" ADD CONSTRAINT "trip_reviews_rejections_have_a_reason"
  CHECK ("moderationStatus" <> 'REJECTED' OR btrim(coalesce("rejectionReason", '')) <> '');
