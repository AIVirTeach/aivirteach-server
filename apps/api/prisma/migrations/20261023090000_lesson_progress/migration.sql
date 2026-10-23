BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "EnrollmentCompletion" LIMIT 1) THEN
    RAISE EXCEPTION 'EnrollmentCompletion contains rows; archive them explicitly before learning-state consolidation';
  END IF;
END $$;

ALTER TABLE "Enrollment" ADD COLUMN "progressRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Enrollment" ADD COLUMN "learningState" JSONB NOT NULL DEFAULT '{"schemaVersion":1,"readingLessonId":null,"lessons":{},"completedAt":null}'::jsonb;

CREATE TYPE "LearningSnapshotReason" AS ENUM ('MANUAL', 'COMPLETED', 'RESTART', 'LEGACY_ACHIEVEMENT');
CREATE TABLE "LearningSnapshot" (
  "id" TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL,
  "sourceGeneration" INTEGER NOT NULL,
  "sourceRevision" INTEGER NOT NULL,
  "courseVersionId" TEXT,
  "schemaVersion" INTEGER NOT NULL,
  "state" JSONB NOT NULL,
  "reason" "LearningSnapshotReason" NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LearningSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LearningSnapshot_enrollmentId_idempotencyKey_key" ON "LearningSnapshot"("enrollmentId", "idempotencyKey");
CREATE INDEX "LearningSnapshot_enrollmentId_createdAt_idx" ON "LearningSnapshot"("enrollmentId", "createdAt");
ALTER TABLE "LearningSnapshot" ADD CONSTRAINT "LearningSnapshot_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearningSnapshot" ADD CONSTRAINT "LearningSnapshot_courseVersionId_fkey" FOREIGN KEY ("courseVersionId") REFERENCES "CourseVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


INSERT INTO "LearningSnapshot" ("id", "enrollmentId", "sourceGeneration", "sourceRevision", "courseVersionId", "schemaVersion", "state", "reason", "idempotencyKey", "createdAt")
SELECT 'legacy-achievement-' || md5(e."id"), e."id", e."generation", e."progressRevision", NULL, 0,
       jsonb_build_object('legacy', true, 'completeStateAvailable', false,
         'completedAt', to_char(e."completedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
       'LEGACY_ACHIEVEMENT', 'legacy-achievement:' || e."generation", e."completedAt"
FROM "Enrollment" e WHERE e."completedAt" IS NOT NULL;

UPDATE "Enrollment" e SET "learningState" = jsonb_set(
  e."learningState", '{readingLessonId}',
  COALESCE(to_jsonb(p."currentLessonContentId"), to_jsonb(l."contentId"), 'null'::jsonb), true)
FROM "Progress" p LEFT JOIN "CourseLesson" l ON l."id" = p."currentLessonId"
WHERE p."enrollmentId" = e."id";
UPDATE "Enrollment" e SET "learningState" = jsonb_set(
  e."learningState", '{completedAt}',
  to_jsonb(to_char(e."completedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true)
WHERE e."completedAt" IS NOT NULL;


ALTER TABLE "Progress" DROP CONSTRAINT IF EXISTS "Progress_currentLessonId_fkey";
ALTER TABLE "Progress" DROP CONSTRAINT IF EXISTS "Progress_enrollmentId_fkey";
DROP TABLE "Progress";
ALTER TABLE "Enrollment" DROP CONSTRAINT IF EXISTS "Enrollment_currentModuleId_fkey";
ALTER TABLE "Enrollment" DROP COLUMN "currentModuleId";
ALTER TABLE "Enrollment" DROP COLUMN "completedAt";
DROP TABLE "EnrollmentCompletion";
DROP TYPE "ExportStatus";
COMMIT;
