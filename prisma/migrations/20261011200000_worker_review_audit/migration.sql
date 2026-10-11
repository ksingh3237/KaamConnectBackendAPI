-- D-9 (Aadhaar images are deleted N days after the VERIFIED/REJECTED decision) needs to know WHEN and BY WHOM
-- a worker was decided. Until now only an approval left a time (verified_at), a rejection left none, and the
-- reviewer's id was written to the log and nowhere else.
--
-- Additive only: two nullable columns with no default and one foreign key. Nothing is dropped or rewritten, the
-- running app ignores the columns, so this can be applied before the code that uses them is deployed.

-- AlterTable
ALTER TABLE "worker_profiles" ADD COLUMN     "reviewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "reviewed_by" UUID;

-- AddForeignKey
-- SET NULL: removing an admin account must never remove or block a worker; the decision time stays.
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill (hand-written; Prisma does not generate data statements).
--
-- Only what was really recorded is carried over. An approval already has its own timestamp, so it becomes the
-- decision time. NOTHING is invented:
--   * reviewed_by stays NULL for every existing row. Who approved or rejected them was never stored.
--   * a REJECTED worker has no recorded decision time, so reviewed_at stays NULL. The retention sweep treats a
--     NULL decision time as "unknown, never delete automatically"; any such legacy row is cleaned by hand.
--   * PENDING workers have no decision.
UPDATE "worker_profiles"
SET    "reviewed_at" = "verified_at"
WHERE  "verification_status" = 'VERIFIED'
  AND  "verified_at" IS NOT NULL
  AND  "reviewed_at" IS NULL;
