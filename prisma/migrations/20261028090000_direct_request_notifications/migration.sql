-- Tells a customer when the worker they asked for personally declines or does not answer in time.
-- Additive only: two new NotificationType values. No row or column is touched, so it can be applied before the code ships.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'DIRECT_DECLINED';
ALTER TYPE "NotificationType" ADD VALUE 'DIRECT_EXPIRED';
