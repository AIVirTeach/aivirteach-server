ALTER TABLE "Conversation"
  ADD COLUMN "requestId" TEXT,
  ADD COLUMN "generation" INTEGER,
  ADD COLUMN "courseVersionId" TEXT,
  ADD COLUMN "lessonContentId" TEXT;
CREATE UNIQUE INDEX "Conversation_enrollmentId_generation_requestId_role_key"
  ON "Conversation"("enrollmentId", "generation", "requestId", "role");
