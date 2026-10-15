-- Three small features, one additive migration.
--
-- 1. Worker "taking jobs" switch (worker_profiles.is_available). Off: no new-lead notifications, hidden from customer
--    discovery, direct bookings refused. Default true, so every existing worker keeps behaving exactly as before.
-- 2. Worker address (worker_profiles.address_line): shop / workshop / home. Personal data: cleared when the account
--    is deleted, never shown to customers.
-- 3. Typed locality for places missing from the sector list (locality_name on addresses, jobs and worker_profiles).
--    The row still points at a real area of the chosen city (the seeded "Other area"), which is what matching uses.
--
-- Additive only: nullable columns and one boolean with a constant default (no table rewrite on PostgreSQL 11+).
-- The running app ignores the columns, so this can be applied before the code that uses them is deployed.

-- AlterTable
ALTER TABLE "worker_profiles" ADD COLUMN     "address_line" VARCHAR(200),
ADD COLUMN     "locality_name" VARCHAR(80),
ADD COLUMN     "is_available" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "addresses" ADD COLUMN     "locality_name" VARCHAR(80);

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "locality_name" VARCHAR(80);
