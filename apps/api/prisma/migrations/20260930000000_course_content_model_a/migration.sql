-- Migration A: additive course content model changes. This file is intentionally not applied.
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
