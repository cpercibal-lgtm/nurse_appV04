-- Announcements (D-69; owner request and decisions 2026-10-05): memos, meeting schedules and
-- seminar notices. An announcement is written once and, when published, fanned out to one
-- notifications row per recipient account (type ANNOUNCEMENT, linked by announcement_id) and one
-- email_outbox row per contact address of staff without an account, both with event key
-- 'announcement:<id>'. HR / System Admin sends wait for a second administrator (approval_requests);
-- a Supervisor's send to their own units is published at once. Nothing is edited once sent:
-- an announcement is cancelled. Nothing here is seeded.

-- CreateEnum
CREATE TYPE "AnnouncementKind" AS ENUM ('MEMO', 'MEETING', 'SEMINAR');

-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AudienceType" AS ENUM ('HOSPITAL', 'DEPARTMENT', 'UNIT', 'PEOPLE');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'ANNOUNCEMENT';

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "announcement_id" INTEGER;

-- CreateTable
CREATE TABLE "announcements" (
    "id" SERIAL NOT NULL,
    "kind" "AnnouncementKind" NOT NULL,
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" "NotificationPriority" NOT NULL DEFAULT 'LOW',
    "title" VARCHAR(150) NOT NULL,
    "body" VARCHAR(5000) NOT NULL,
    "title_ar" VARCHAR(150),
    "body_ar" VARCHAR(5000),
    "reference_no" VARCHAR(50),
    "starts_at" TIMESTAMPTZ,
    "ends_at" TIMESTAMPTZ,
    "location" VARCHAR(200),
    "online_url" VARCHAR(500),
    "speaker" VARCHAR(150),
    "ce_hours" DECIMAL(4,1),
    "audience_type" "AudienceType" NOT NULL,
    "audience_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "role_filter" "AppRole"[] DEFAULT ARRAY[]::"AppRole"[],
    "position_filter" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "specialty_filter" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recipient_count" INTEGER,
    "email_only_count" INTEGER,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_by_id" INTEGER NOT NULL,
    "published_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "cancelled_by_id" INTEGER,
    "cancel_reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_status_expires_at_idx" ON "announcements"("status", "expires_at");

-- CreateIndex
CREATE INDEX "announcements_created_by_id_status_idx" ON "announcements"("created_by_id", "status");

-- CreateIndex
CREATE INDEX "notifications_announcement_id_idx" ON "notifications"("announcement_id");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Meetings and seminars have a start; an end comes after the start.
ALTER TABLE "announcements"
  ADD CONSTRAINT "chk_announcements_event_time" CHECK ("kind" = 'MEMO' OR "starts_at" IS NOT NULL),
  ADD CONSTRAINT "chk_announcements_end_after_start" CHECK ("ends_at" IS NULL OR ("starts_at" IS NOT NULL AND "ends_at" > "starts_at")),
  -- An online meeting link is https and one piece (no spaces).
  ADD CONSTRAINT "chk_announcements_online_url" CHECK ("online_url" IS NULL OR "online_url" ~ '^https://[^[:space:]]+$'),
  ADD CONSTRAINT "chk_announcements_text" CHECK (btrim("title") <> '' AND btrim("body") <> ''),
  -- Continuing-education hours belong to seminars.
  ADD CONSTRAINT "chk_announcements_ce_hours" CHECK ("ce_hours" IS NULL OR ("kind" = 'SEMINAR' AND "ce_hours" >= 0)),
  -- Owner decision Q7: CRITICAL stays for system alerts.
  ADD CONSTRAINT "chk_announcements_priority" CHECK ("priority" <> 'CRITICAL'),
  -- The whole hospital has no ids; every other audience names at least one.
  ADD CONSTRAINT "chk_announcements_audience" CHECK (("audience_type" = 'HOSPITAL') = (COALESCE(cardinality("audience_ids"), 0) = 0)),
  ADD CONSTRAINT "chk_announcements_filters" CHECK ("role_filter" IS NOT NULL AND "position_filter" IS NOT NULL AND "specialty_filter" IS NOT NULL),
  ADD CONSTRAINT "chk_announcements_counts" CHECK (COALESCE("recipient_count", 0) >= 0 AND COALESCE("email_only_count", 0) >= 0),
  -- Published (and later cancelled) rows carry their publication time and frozen counts;
  -- only those have them. Cancelled rows carry who/when/why.
  ADD CONSTRAINT "chk_announcements_published" CHECK (
    ("status" IN ('PUBLISHED', 'CANCELLED')) = ("published_at" IS NOT NULL)
    AND ("published_at" IS NULL OR ("recipient_count" IS NOT NULL AND "email_only_count" IS NOT NULL))),
  ADD CONSTRAINT "chk_announcements_cancelled" CHECK (
    ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)
    AND ("cancelled_at" IS NULL OR "cancel_reason" IS NOT NULL));

-- A notification belongs to an announcement exactly when it is one. Compared as text: the enum
-- value added above cannot be used as a literal in the transaction that adds it.
ALTER TABLE "notifications"
  ADD CONSTRAINT "chk_notifications_announcement" CHECK (("announcement_id" IS NULL) = ("type"::text <> 'ANNOUNCEMENT'));
