-- AlterTable
ALTER TABLE "CourseLesson" ADD COLUMN "contentId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "CourseLesson_contentId_key" ON "CourseLesson"("contentId");
