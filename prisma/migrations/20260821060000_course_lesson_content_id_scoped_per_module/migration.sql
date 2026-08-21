-- DropIndex
DROP INDEX "CourseLesson_contentId_key";

-- CreateIndex
CREATE UNIQUE INDEX "CourseLesson_moduleId_contentId_key" ON "CourseLesson"("moduleId", "contentId");
