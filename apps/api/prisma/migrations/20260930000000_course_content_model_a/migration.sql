-- Migration A: additive course content model changes (nullable/defaulted columns, one partial unique index).
-- Before applying to a database that already holds courses, check that no course has more than one
-- unpublished version, otherwise the partial unique index below fails:
--   SELECT "courseId", count(*) FROM "CourseVersion" WHERE "publishedAt" IS NULL GROUP BY 1 HAVING count(*) > 1;
BEGIN;

ALTER TABLE "CourseLesson"
  ADD COLUMN "body" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "content" JSONB,
  ALTER COLUMN "sourceRange" DROP NOT NULL;

ALTER TABLE "CourseVersion"
  ADD COLUMN "meta" JSONB;

ALTER TABLE "Progress"
  ADD COLUMN "currentLessonContentId" TEXT;

CREATE UNIQUE INDEX "CourseVersion_one_draft_per_course"
  ON "CourseVersion"("courseId")
  WHERE "publishedAt" IS NULL;

COMMIT;
