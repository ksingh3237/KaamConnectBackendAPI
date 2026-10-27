-- Worker no-show (docs/15-no-show.md): an assigned worker who has not arrived a grace period after their promised
-- arrival is released automatically. Additive except for three CHECK rules on job_cancellations, which are replaced by
-- rules that also allow the system as the one who cancelled; every existing row satisfies the new rules.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'JOB_WORKER_LATE';
ALTER TYPE "NotificationType" ADD VALUE 'JOB_YOU_ARE_LATE';
ALTER TYPE "NotificationType" ADD VALUE 'JOB_NO_SHOW_RELEASED';

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "late_notified_at" TIMESTAMPTZ(3);
ALTER TABLE "job_cancellations" ADD COLUMN "excused_at" TIMESTAMPTZ(3);

-- Hand-written rules (Prisma cannot express CHECKs). The system may cancel only as a no-show release: it never
-- cancels on a customer's behalf, and then there is no person behind it (actor_id IS NULL).
ALTER TABLE "job_cancellations" DROP CONSTRAINT "job_cancellations_actor_role_person";
ALTER TABLE "job_cancellations" ADD CONSTRAINT "job_cancellations_actor_role_person"
  CHECK ("actor_role" IN ('CUSTOMER', 'WORKER', 'SYSTEM'));
ALTER TABLE "job_cancellations" ADD CONSTRAINT "job_cancellations_system_has_no_actor"
  CHECK ("actor_role" <> 'SYSTEM' OR ("actor_id" IS NULL AND "worker_id" IS NOT NULL));

ALTER TABLE "job_cancellations" DROP CONSTRAINT "job_cancellations_counts_are_workers";
ALTER TABLE "job_cancellations" ADD CONSTRAINT "job_cancellations_counts_are_workers"
  CHECK (NOT "counts_against_worker" OR "actor_role" IN ('WORKER', 'SYSTEM'));

ALTER TABLE "job_cancellations" DROP CONSTRAINT "job_cancellations_reopen_is_worker_assigned";
ALTER TABLE "job_cancellations" ADD CONSTRAINT "job_cancellations_reopen_is_worker_assigned"
  CHECK (NOT "reopened" OR ("actor_role" IN ('WORKER', 'SYSTEM') AND "stage" = 'ASSIGNED'));
