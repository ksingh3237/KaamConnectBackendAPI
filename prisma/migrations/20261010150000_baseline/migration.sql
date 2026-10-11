-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('en', 'hi', 'pa');

-- CreateEnum
CREATE TYPE "OtpChannel" AS ENUM ('SMS', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('AADHAAR_FRONT', 'AADHAAR_BACK');

-- CreateEnum
CREATE TYPE "JobTiming" AS ENUM ('IMMEDIATE', 'AFTERNOON', 'TOMORROW');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('OPEN', 'ASSIGNED', 'ARRIVED', 'IN_PROGRESS', 'WORK_COMPLETED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CancelledBy" AS ENUM ('CUSTOMER', 'WORKER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "JobMediaKind" AS ENUM ('PROBLEM_PHOTO', 'VOICE_NOTE', 'BEFORE_PHOTO', 'AFTER_PHOTO');

-- CreateEnum
CREATE TYPE "BillItemKind" AS ENUM ('VISIT_FEE', 'PARTS', 'LABOUR', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('UPI', 'CASH');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('MARKED_PAID', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "ReviewTag" AS ENUM ('PUNCTUAL', 'FAIR_PRICE', 'CLEAN_WORK', 'POLITE', 'EXPERT_SKILL');

-- CreateEnum
CREATE TYPE "SosStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(15) NOT NULL,
    "language" "Language" NOT NULL DEFAULT 'en',
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(15) NOT NULL,
    "code_hash" TEXT NOT NULL,
    "channel" "OtpChannel" NOT NULL DEFAULT 'SMS',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cities" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "cities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "areas" (
    "id" SERIAL NOT NULL,
    "city_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,

    CONSTRAINT "areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_categories" (
    "id" TEXT NOT NULL,
    "title_en" TEXT NOT NULL,
    "title_hi" TEXT NOT NULL,
    "title_pa" TEXT NOT NULL,
    "icon_key" TEXT NOT NULL,
    "color" VARCHAR(7) NOT NULL,
    "bg_color" VARCHAR(7) NOT NULL,
    "base_visit_fee" INTEGER NOT NULL,
    "examples" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_profiles" (
    "user_id" UUID NOT NULL,
    "full_name" VARCHAR(80) NOT NULL,
    "photo_key" TEXT,
    "comm_language" "Language" NOT NULL DEFAULT 'hi',
    "allow_direct_calls" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "area_id" INTEGER NOT NULL,
    "line" VARCHAR(200) NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_profiles" (
    "user_id" UUID NOT NULL,
    "full_name" VARCHAR(80) NOT NULL,
    "photo_key" TEXT,
    "base_area_id" INTEGER NOT NULL,
    "radius_km" INTEGER NOT NULL DEFAULT 6,
    "experience_years" INTEGER NOT NULL,
    "languages" "Language"[],
    "skills" TEXT[],
    "visiting_fee" INTEGER,
    "vehicle" VARCHAR(80),
    "upi_id" VARCHAR(80),
    "badge" VARCHAR(60),
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verified_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "terms_accepted_at" TIMESTAMPTZ(3) NOT NULL,
    "rating_sum" INTEGER NOT NULL DEFAULT 0,
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "worker_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "worker_trades" (
    "worker_id" UUID NOT NULL,
    "category_id" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "worker_trades_pkey" PRIMARY KEY ("worker_id","category_id")
);

-- CreateTable
CREATE TABLE "worker_documents" (
    "id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "type" "DocumentType" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_locations" (
    "worker_id" UUID NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "worker_locations_pkey" PRIMARY KEY ("worker_id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "job_number" SERIAL NOT NULL,
    "customer_id" UUID NOT NULL,
    "category_id" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "timing" "JobTiming" NOT NULL,
    "area_id" INTEGER NOT NULL,
    "address_line" VARCHAR(200) NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "status" "JobStatus" NOT NULL DEFAULT 'OPEN',
    "target_worker_id" UUID,
    "worker_id" UUID,
    "accepted_offer_id" UUID,
    "arrival_code" VARCHAR(4),
    "arrival_attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3),
    "assigned_at" TIMESTAMPTZ(3),
    "arrived_at" TIMESTAMPTZ(3),
    "cost_approved_at" TIMESTAMPTZ(3),
    "work_completed_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" "CancelledBy",
    "cancel_reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_media" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "kind" "JobMediaKind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "duration_sec" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "visit_fee" INTEGER NOT NULL,
    "eta_minutes" INTEGER NOT NULL,
    "message" VARCHAR(300),
    "status" "OfferStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_items" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "kind" "BillItemKind" NOT NULL,
    "description" VARCHAR(120) NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'MARKED_PAID',
    "marked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "tags" "ReviewTag"[],
    "tip_amount" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sos_alerts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "job_id" UUID,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "status" "SosStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sos_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "otp_challenges_phone_created_at_idx" ON "otp_challenges"("phone", "created_at");

-- CreateIndex
CREATE INDEX "otp_challenges_expires_at_idx" ON "otp_challenges"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "cities_name_key" ON "cities"("name");

-- CreateIndex
CREATE UNIQUE INDEX "areas_city_id_name_key" ON "areas"("city_id", "name");

-- CreateIndex
CREATE INDEX "addresses_customer_id_idx" ON "addresses"("customer_id");

-- CreateIndex
CREATE INDEX "worker_profiles_base_area_id_verification_status_idx" ON "worker_profiles"("base_area_id", "verification_status");

-- CreateIndex
CREATE INDEX "worker_trades_category_id_idx" ON "worker_trades"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "worker_documents_worker_id_type_key" ON "worker_documents"("worker_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_job_number_key" ON "jobs"("job_number");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_accepted_offer_id_key" ON "jobs"("accepted_offer_id");

-- CreateIndex
CREATE INDEX "jobs_status_category_id_area_id_created_at_idx" ON "jobs"("status", "category_id", "area_id", "created_at");

-- CreateIndex
CREATE INDEX "jobs_customer_id_status_created_at_idx" ON "jobs"("customer_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "jobs_worker_id_status_created_at_idx" ON "jobs"("worker_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "jobs_target_worker_id_status_idx" ON "jobs"("target_worker_id", "status");

-- CreateIndex
CREATE INDEX "jobs_status_expires_at_idx" ON "jobs"("status", "expires_at");

-- CreateIndex
CREATE INDEX "job_media_job_id_kind_idx" ON "job_media"("job_id", "kind");

-- CreateIndex
CREATE INDEX "offers_worker_id_status_idx" ON "offers"("worker_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "offers_job_id_worker_id_key" ON "offers"("job_id", "worker_id");

-- CreateIndex
CREATE INDEX "bill_items_job_id_idx" ON "bill_items"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_job_id_key" ON "payments"("job_id");

-- CreateIndex
CREATE INDEX "payments_marked_at_idx" ON "payments"("marked_at");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_job_id_key" ON "reviews"("job_id");

-- CreateIndex
CREATE INDEX "reviews_worker_id_created_at_idx" ON "reviews"("worker_id", "created_at");

-- CreateIndex
CREATE INDEX "sos_alerts_status_created_at_idx" ON "sos_alerts"("status", "created_at");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_base_area_id_fkey" FOREIGN KEY ("base_area_id") REFERENCES "areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_trades" ADD CONSTRAINT "worker_trades_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_trades" ADD CONSTRAINT "worker_trades_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_documents" ADD CONSTRAINT "worker_documents_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_locations" ADD CONSTRAINT "worker_locations_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_target_worker_id_fkey" FOREIGN KEY ("target_worker_id") REFERENCES "worker_profiles"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_accepted_offer_id_fkey" FOREIGN KEY ("accepted_offer_id") REFERENCES "offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_media" ADD CONSTRAINT "job_media_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written constraints (Prisma cannot express these). docs/02-database.md §5
-- Keep this block when regenerating; `prisma migrate diff` ignores CHECKs.
-- ═══════════════════════════════════════════════════════════════════════════

-- Money and numeric ranges
ALTER TABLE "offers"          ADD CONSTRAINT "offers_fee_range"        CHECK ("visit_fee" > 0 AND "visit_fee" <= 100000);
ALTER TABLE "offers"          ADD CONSTRAINT "offers_eta_range"        CHECK ("eta_minutes" BETWEEN 5 AND 240);
ALTER TABLE "bill_items"      ADD CONSTRAINT "bill_items_amount_nonneg" CHECK ("amount" >= 0);
ALTER TABLE "payments"        ADD CONSTRAINT "payments_amount_pos"     CHECK ("amount" > 0);
ALTER TABLE "reviews"         ADD CONSTRAINT "reviews_rating_range"    CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "reviews"         ADD CONSTRAINT "reviews_tip_nonneg"      CHECK ("tip_amount" >= 0);
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_radius_allowed" CHECK ("radius_km" IN (3, 6, 12));
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_experience_range" CHECK ("experience_years" BETWEEN 1 AND 40);
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_counters_nonneg" CHECK ("rating_sum" >= 0 AND "review_count" >= 0);
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_visiting_fee_nonneg" CHECK ("visiting_fee" IS NULL OR "visiting_fee" > 0);
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_fee_nonneg" CHECK ("base_visit_fee" >= 0);

-- Coordinates
ALTER TABLE "areas"            ADD CONSTRAINT "areas_coords_range"            CHECK (("lat" IS NULL OR "lat" BETWEEN -90 AND 90)  AND ("lng" IS NULL OR "lng" BETWEEN -180 AND 180));
ALTER TABLE "addresses"        ADD CONSTRAINT "addresses_coords_range"        CHECK (("lat" IS NULL OR "lat" BETWEEN -90 AND 90)  AND ("lng" IS NULL OR "lng" BETWEEN -180 AND 180));
ALTER TABLE "jobs"             ADD CONSTRAINT "jobs_coords_range"             CHECK (("lat" IS NULL OR "lat" BETWEEN -90 AND 90)  AND ("lng" IS NULL OR "lng" BETWEEN -180 AND 180));
ALTER TABLE "worker_locations" ADD CONSTRAINT "worker_locations_coords_range" CHECK ("lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180);
ALTER TABLE "sos_alerts"       ADD CONSTRAINT "sos_alerts_coords_range"       CHECK (("lat" IS NULL OR "lat" BETWEEN -90 AND 90)  AND ("lng" IS NULL OR "lng" BETWEEN -180 AND 180));

-- Exactly one primary address per customer; exactly one primary trade per worker
CREATE UNIQUE INDEX "addresses_one_primary_per_customer" ON "addresses" ("customer_id") WHERE "is_primary";
CREATE UNIQUE INDEX "worker_trades_one_primary_per_worker" ON "worker_trades" ("worker_id") WHERE "is_primary";

-- Job state coherence
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_has_worker"
  CHECK ("status" IN ('OPEN', 'CANCELLED') OR "worker_id" IS NOT NULL);
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_arrival_code_format"
  CHECK ("arrival_code" IS NULL OR "arrival_code" ~ '^[0-9]{4}$');
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_cancelled_has_actor"
  CHECK ("status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND "cancelled_by" IS NOT NULL));

-- Human-friendly job numbers: the first job is KC-10000
-- START WITH (not just RESTART WITH) so TRUNCATE ... RESTART IDENTITY also returns to 10000.
ALTER SEQUENCE "jobs_job_number_seq" START WITH 10000 RESTART;
