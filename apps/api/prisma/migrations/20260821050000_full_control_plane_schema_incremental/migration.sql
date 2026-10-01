-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('PENDING', 'PACKAGING', 'READY', 'FAILED');

-- AlterEnum
ALTER TYPE "WorkspaceStatus" ADD VALUE 'DESTROYED';

-- DropIndex
DROP INDEX "Attempt_enrollmentId_stepIndex_idx";

-- DropIndex
DROP INDEX "Conversation_enrollmentId_idx";

-- AlterTable
ALTER TABLE "Attempt" DROP COLUMN "stepIndex",
ADD COLUMN     "assessmentId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "threadId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "outcomes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "requirements" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "CourseAsset" ADD COLUMN     "type" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "CourseVersion" DROP COLUMN "content",
ADD COLUMN     "introFeaturedAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "introSourceRange" JSONB,
ADD COLUMN     "sourceEncoding" TEXT,
ADD COLUMN     "sourceFormat" TEXT,
ADD COLUMN     "sourceMarkdown" TEXT,
ADD COLUMN     "sourcePath" TEXT;

-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "currentModuleId" TEXT;

-- AlterTable
ALTER TABLE "Progress" DROP COLUMN "currentStep",
ADD COLUMN     "currentLessonId" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "ip" TEXT,
ADD COLUMN     "labId" TEXT,
ADD COLUMN     "labsRawStatus" TEXT,
ADD COLUMN     "rdpPort" INTEGER,
ADD COLUMN     "rdpUsername" TEXT,
ADD COLUMN     "vncPort" INTEGER;

-- CreateTable
CREATE TABLE "CourseModule" (
    "id" TEXT NOT NULL,
    "courseVersionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "estimatedMinutes" INTEGER NOT NULL,

    CONSTRAINT "CourseModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseLesson" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "estimatedMinutes" INTEGER NOT NULL,
    "objectives" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceRange" JSONB NOT NULL,
    "activityType" TEXT NOT NULL,
    "activityPrompt" TEXT NOT NULL,
    "activityCompletionType" TEXT NOT NULL,
    "assessmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "CourseLesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseWelcome" (
    "id" TEXT NOT NULL,
    "courseVersionId" TEXT NOT NULL,
    "overviewAssetId" TEXT,
    "overviewHeading" TEXT,
    "overviewParagraphs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "howItWorksSteps" JSONB,
    "finalOutcome" TEXT,

    CONSTRAINT "CourseWelcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonAssessment" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "clientCriteria" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expectedResult" TEXT,
    "successCriteria" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "commonFailures" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "LessonAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnrollmentCompletion" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "summary" TEXT,
    "exportStatus" "ExportStatus" NOT NULL DEFAULT 'PENDING',
    "exportObjectKey" TEXT,
    "exportFileHash" TEXT,
    "errorMessage" TEXT,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exportedAt" TIMESTAMP(3),

    CONSTRAINT "EnrollmentCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourseModule_courseVersionId_idx" ON "CourseModule"("courseVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "CourseModule_courseVersionId_position_key" ON "CourseModule"("courseVersionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CourseLesson_contentId_key" ON "CourseLesson"("contentId");

-- CreateIndex
CREATE INDEX "CourseLesson_moduleId_idx" ON "CourseLesson"("moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "CourseLesson_moduleId_position_key" ON "CourseLesson"("moduleId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CourseWelcome_courseVersionId_key" ON "CourseWelcome"("courseVersionId");

-- CreateIndex
CREATE INDEX "LessonAssessment_lessonId_idx" ON "LessonAssessment"("lessonId");

-- CreateIndex
CREATE UNIQUE INDEX "EnrollmentCompletion_enrollmentId_key" ON "EnrollmentCompletion"("enrollmentId");

-- CreateIndex
CREATE INDEX "Attempt_enrollmentId_assessmentId_idx" ON "Attempt"("enrollmentId", "assessmentId");

-- CreateIndex
CREATE INDEX "Conversation_enrollmentId_threadId_idx" ON "Conversation"("enrollmentId", "threadId");

-- CreateIndex
CREATE INDEX "Enrollment_currentModuleId_idx" ON "Enrollment"("currentModuleId");

-- CreateIndex
CREATE INDEX "Progress_currentLessonId_idx" ON "Progress"("currentLessonId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_labId_key" ON "Workspace"("labId");

-- AddForeignKey
ALTER TABLE "CourseModule" ADD CONSTRAINT "CourseModule_courseVersionId_fkey" FOREIGN KEY ("courseVersionId") REFERENCES "CourseVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseLesson" ADD CONSTRAINT "CourseLesson_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "CourseModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseWelcome" ADD CONSTRAINT "CourseWelcome_courseVersionId_fkey" FOREIGN KEY ("courseVersionId") REFERENCES "CourseVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonAssessment" ADD CONSTRAINT "LessonAssessment_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "CourseLesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_currentModuleId_fkey" FOREIGN KEY ("currentModuleId") REFERENCES "CourseModule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Progress" ADD CONSTRAINT "Progress_currentLessonId_fkey" FOREIGN KEY ("currentLessonId") REFERENCES "CourseLesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "LessonAssessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrollmentCompletion" ADD CONSTRAINT "EnrollmentCompletion_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

