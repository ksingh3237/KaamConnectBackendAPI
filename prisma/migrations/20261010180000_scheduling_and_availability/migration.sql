-- Scheduling and availability (docs/01-requirements.md FR-SCHEDULING, BR-13 to BR-22).
--  * jobs get a requested appointment time and a reserved booking window
--  * worker_leads records which leads reached which worker (no duplicate pushes) and their answer
--  * offers remember when the customer accepted them
--  * workers can say how far they will travel for future work
--  * PostgreSQL itself refuses overlapping bookings and a second job in progress for one worker

-- AlterEnum
-- (The new value is not used in this migration: PostgreSQL forbids that inside the same transaction.)
ALTER TYPE "JobTiming" ADD VALUE 'SCHEDULED';

-- CreateEnum
CREATE TYPE "LeadResponse" AS ENUM ('ACCEPTED', 'DECLINED');

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "scheduled_for" TIMESTAMPTZ(3),
ADD COLUMN     "duration_min" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "booked_start_at" TIMESTAMPTZ(3),
ADD COLUMN     "booked_end_at" TIMESTAMPTZ(3),
ADD COLUMN     "booking_confirmed_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "offers" ADD COLUMN     "accepted_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "worker_profiles" ADD COLUMN     "scheduled_radius_km" INTEGER;

-- CreateTable
CREATE TABLE "worker_leads" (
    "job_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "delivered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "response" "LeadResponse",
    "responded_at" TIMESTAMPTZ(3),

    CONSTRAINT "worker_leads_pkey" PRIMARY KEY ("job_id","worker_id")
);

-- CreateIndex
CREATE INDEX "worker_leads_worker_id_delivered_at_idx" ON "worker_leads"("worker_id", "delivered_at");

-- AddForeignKey
ALTER TABLE "worker_leads" ADD CONSTRAINT "worker_leads_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_leads" ADD CONSTRAINT "worker_leads_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written constraints (Prisma cannot express these). Keep this block when regenerating;
-- `prisma migrate diff` ignores CHECKs, partial indexes and exclusion constraints.
-- ═══════════════════════════════════════════════════════════════════════════

-- Jobs that were already assigned before this migration get a window of the default length starting
-- when they were assigned, so the coherence CHECK below holds for them too.
UPDATE "jobs"
SET "booked_start_at" = COALESCE("assigned_at", "created_at"),
    "booked_end_at" = COALESCE("assigned_at", "created_at") + interval '90 minutes',
    "booking_confirmed_at" = COALESCE("assigned_at", "created_at")
WHERE "worker_id" IS NOT NULL
  AND "status" IN ('ASSIGNED', 'ARRIVED', 'IN_PROGRESS', 'WORK_COMPLETED', 'COMPLETED');

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_duration_range"
  CHECK ("duration_min" BETWEEN 15 AND 480);
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_booking_window_valid"
  CHECK (("booked_start_at" IS NULL AND "booked_end_at" IS NULL)
      OR ("booked_start_at" IS NOT NULL AND "booked_end_at" IS NOT NULL AND "booked_end_at" > "booked_start_at"));
-- Once a worker is assigned the booking must have been confirmed with a window.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_has_booking"
  CHECK ("status" NOT IN ('ASSIGNED', 'ARRIVED', 'IN_PROGRESS', 'WORK_COMPLETED', 'COMPLETED')
      OR ("booked_start_at" IS NOT NULL AND "booking_confirmed_at" IS NOT NULL));

ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_scheduled_radius_allowed"
  CHECK ("scheduled_radius_km" IS NULL OR "scheduled_radius_km" IN (3, 6, 12, 25, 50));

ALTER TABLE "worker_leads" ADD CONSTRAINT "worker_leads_response_pair"
  CHECK (("response" IS NULL) = ("responded_at" IS NULL));

-- One worker cannot hold two overlapping bookings. WORK_COMPLETED is deliberately outside the rule:
-- the work is done, only payment is pending, so the worker is free again.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_worker_no_overlap"
  EXCLUDE USING gist ("worker_id" WITH =, tstzrange("booked_start_at", "booked_end_at", '[)') WITH &&)
  WHERE ("status" IN ('ASSIGNED', 'ARRIVED', 'IN_PROGRESS') AND "booked_start_at" IS NOT NULL);

-- At most one job in progress per worker.
CREATE UNIQUE INDEX "jobs_one_in_progress_per_worker" ON "jobs" ("worker_id")
  WHERE "status" IN ('ARRIVED', 'IN_PROGRESS');

-- The availability check reads one worker's active bookings in time order.
CREATE INDEX "jobs_worker_booked_idx" ON "jobs" ("worker_id", "booked_start_at")
  WHERE "status" IN ('ASSIGNED', 'ARRIVED', 'IN_PROGRESS');
