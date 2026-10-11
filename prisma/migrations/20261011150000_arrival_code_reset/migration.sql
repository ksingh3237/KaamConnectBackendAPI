-- Arrival-code recovery: a customer can have a NEW code issued (at most 3 times per assignment, at least
-- 60 seconds apart), and every lock / reset / refused reset is written to an append-only audit table.
-- Additive only: two new columns with defaults, one new enum, one new table. Nothing is dropped,
-- rewritten or back-filled, so existing rows and the running app are unaffected.

-- CreateEnum
CREATE TYPE "JobSecurityEventType" AS ENUM ('ARRIVAL_LOCKED', 'ARRIVAL_CODE_RESET', 'ARRIVAL_RESET_REFUSED');

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "arrival_code_reset_at" TIMESTAMPTZ(3),
ADD COLUMN     "arrival_code_resets" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "job_security_events" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "actor_id" UUID,
    "type" "JobSecurityEventType" NOT NULL,
    "detail" VARCHAR(40),
    "ip" VARCHAR(45),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_security_events_job_id_created_at_idx" ON "job_security_events"("job_id", "created_at");

-- AddForeignKey
ALTER TABLE "job_security_events" ADD CONSTRAINT "job_security_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_security_events" ADD CONSTRAINT "job_security_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written constraint (Prisma cannot express CHECKs). The upper limit (3) lives in code so it can be
-- tuned without a migration; the database only guarantees the counter is never negative.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_arrival_code_resets_nonneg" CHECK ("arrival_code_resets" >= 0);
