-- Per-service default job length (decision D-14). Empty means "use BOOKING_DEFAULT_DURATION_MIN" (90 min),
-- so nothing changes until a number is set for a service. A customer can still send durationMin per job.

-- AlterTable
ALTER TABLE "service_categories" ADD COLUMN     "default_duration_min" INTEGER;

-- Hand-written constraint (Prisma cannot express CHECKs), same range as jobs.duration_min.
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_duration_range"
  CHECK ("default_duration_min" IS NULL OR "default_duration_min" BETWEEN 15 AND 480);
