ALTER TABLE "Enrollment" ADD COLUMN "progressRevision" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "LessonProgress" (
  "enrollmentId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "contentId" TEXT NOT NULL,
  "completedAt" TIMESTAMP(3),
  "firstCompletedAt" TIMESTAMP(3),
  CONSTRAINT "LessonProgress_pkey" PRIMARY KEY ("enrollmentId", "generation", "contentId"),
  CONSTRAINT "LessonProgress_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "CourseCompletionHistory" (
  "enrollmentId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourseCompletionHistory_pkey" PRIMARY KEY ("enrollmentId", "generation"),
  CONSTRAINT "CourseCompletionHistory_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Preserve achievements without inventing a set of completed lessons.
INSERT INTO "CourseCompletionHistory" ("enrollmentId", "generation", "completedAt")
SELECT "id", "generation", "completedAt" FROM "Enrollment" WHERE "completedAt" IS NOT NULL;
