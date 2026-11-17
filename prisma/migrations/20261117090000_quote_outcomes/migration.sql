-- Tells a worker what happened to their quote: declined by the customer, another worker chosen, or the request cancelled.
-- Additive only: three new NotificationType values and one nullable column. No existing row is changed, so it can be
-- applied before the code ships.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'QUOTE_DECLINED';
ALTER TYPE "NotificationType" ADD VALUE 'QUOTE_NOT_SELECTED';
ALTER TYPE "NotificationType" ADD VALUE 'LEAD_CANCELLED';

-- AlterTable
ALTER TABLE "offers" ADD COLUMN "declined_at" TIMESTAMPTZ(3);
