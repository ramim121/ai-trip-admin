-- Journey planner surfaces, so its spend is attributable.
--
-- The existing values describe the curated planner. Folding journey calls into
-- PLANNER and SUGGESTION would work, and would cost the console the one question
-- it exists to answer: which feature is spending the money. A funnel running
-- eight model calls per trip has to be separable from a planner running one per
-- turn, or the first month's bill is unattributable.
--
-- Additive only. Existing rows keep their values, and nothing here is read until
-- the code that writes it ships.

ALTER TYPE "AiSurface" ADD VALUE IF NOT EXISTS 'JOURNEY_INTAKE';
ALTER TYPE "AiSurface" ADD VALUE IF NOT EXISTS 'JOURNEY_SKELETON';
ALTER TYPE "AiSurface" ADD VALUE IF NOT EXISTS 'JOURNEY_BRIEF';
ALTER TYPE "AiSurface" ADD VALUE IF NOT EXISTS 'JOURNEY_RANKER';
ALTER TYPE "AiSurface" ADD VALUE IF NOT EXISTS 'JOURNEY_TRANSFER';
ALTER TYPE "AiSurface" ADD VALUE IF NOT EXISTS 'JOURNEY_CHAT';
ALTER TYPE "AiSurface" ADD VALUE IF NOT EXISTS 'JOURNEY_ELICITOR';
