-- Two features that need new columns, in one additive migration.
--
-- 1. Account deletion by anonymisation (docs/08 section 1). users.deleted_at tells "deleted" from "disabled by an
--    admin" and makes the operation idempotent; users.deletion_requested_at is the admin queue for a disabled
--    person's request (Door B).
-- 2. SOS delivery tracking. An alert was stored and pushed once, best effort, with no record of whether the desk ever
--    received it. These columns keep what is needed to retry delivery, and to record that a human acknowledged and
--    resolved the alert.
--
-- Additive only: nullable columns or columns with a constant default, three foreign keys that SET NULL, one CHECK and
-- two partial indexes. Nothing is dropped or rewritten and the running app ignores the columns, so this can be applied
-- before the code that uses them is deployed.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3),
ADD COLUMN     "deletion_requested_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "sos_alerts" ADD COLUMN     "payload" JSONB,
ADD COLUMN     "delivered_at" TIMESTAMPTZ(3),
ADD COLUMN     "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_attempt_at" TIMESTAMPTZ(3),
ADD COLUMN     "last_delivery_error" VARCHAR(200),
ADD COLUMN     "acknowledged_at" TIMESTAMPTZ(3),
ADD COLUMN     "acknowledged_by" UUID,
ADD COLUMN     "resolved_at" TIMESTAMPTZ(3),
ADD COLUMN     "resolved_by" UUID;

-- AddForeignKey
-- SET NULL: removing an admin account must never remove or block a safety record; the time stays.
ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written (Prisma cannot express these; keep them here).
-- A failed attempt is counted, never negative.
ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_delivery_attempts_nonneg" CHECK ("delivery_attempts" >= 0);

-- The retry sweep looks only at alerts the desk has not received yet.
CREATE INDEX "sos_alerts_undelivered_idx" ON "sos_alerts" ("created_at") WHERE "delivered_at" IS NULL AND "payload" IS NOT NULL;

-- The admin queue of deletion requests (Door B): requested and not yet deleted.
CREATE INDEX "users_deletion_requested_idx" ON "users" ("deletion_requested_at") WHERE "deletion_requested_at" IS NOT NULL AND "deleted_at" IS NULL;
