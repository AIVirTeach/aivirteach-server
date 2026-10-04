-- AlterTable
ALTER TABLE "Course" ADD COLUMN "contentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Course_contentId_key" ON "Course"("contentId");
