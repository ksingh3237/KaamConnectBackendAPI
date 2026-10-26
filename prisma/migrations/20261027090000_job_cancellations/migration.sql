-- Cancellation records and cancellation notifications (docs/13-cancellation.md).
-- Additive only: two new NotificationType values and one new table. No existing row or column is touched,
-- so it can be applied before the code that uses it ships.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'JOB_CANCELLED_BY_CUSTOMER';
ALTER TYPE "NotificationType" ADD VALUE 'JOB_CANCELLED_BY_WORKER';

-- CreateTable
CREATE TABLE "job_cancellations" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_role" "CancelledBy" NOT NULL,
    "worker_id" UUID,
    "stage" "JobStatus" NOT NULL,
    "reason_code" VARCHAR(40) NOT NULL,
    "note" VARCHAR(300),
    "reopened" BOOLEAN NOT NULL DEFAULT false,
    "counts_against_worker" BOOLEAN NOT NULL DEFAULT false,
    "visit_fee_due" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_cancellations_job_id_created_at_idx" ON "job_cancellations"("job_id", "created_at");

-- CreateIndex
CREATE INDEX "job_cancellations_worker_id_created_at_idx" ON "job_cancellations"("worker_id", "created_at");

-- AddForeignKey
ALTER TABLE "job_cancellations" ADD CONSTRAINT "job_cancellations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_cancellations" ADD CONSTRAINT "job_cancellations_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written rules (Prisma cannot express CHECKs). The system never writes a row here: it expires jobs without a person.
ALTER TABLE "job_cancellations" ADD CONSTRAINT "job_cancellations_actor_role_person"
  CHECK ("actor_role" IN ('CUSTOMER', 'WORKER'));
-- Only a job that had not started can be cancelled by a person.
ALTER TABLE "job_cancellations" ADD CONSTRAINT "job_cancellations_stage_cancellable"
  CHECK ("stage" IN ('OPEN', 'ASSIGNED', 'ARRIVED'));
ALTER TABLE "job_cancellations" ADD CONSTRAINT "job_cancellations_visit_fee_nonneg"
  CHECK ("visit_fee_due" IS NULL OR "visit_fee_due" >= 0);
-- Only a worker's own back-out can count against them, and only a worker back-out on a broadcast job re-opens it.
ALTER TABLE "job_cancellations" ADD CONSTRAINT "job_cancellations_counts_are_workers"
  CHECK (NOT "counts_against_worker" OR "actor_role" = 'WORKER');
ALTER TABLE "job_cancellations" ADD CONSTRAINT "job_cancellations_reopen_is_worker_assigned"
  CHECK (NOT "reopened" OR ("actor_role" = 'WORKER' AND "stage" = 'ASSIGNED'));
