ALTER TABLE "Enrollment" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Workspace" ADD COLUMN "provisionStartedAt" TIMESTAMP(3);
ALTER TABLE "Workspace" ADD COLUMN "provisionGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Workspace" ADD COLUMN "resetRetryAt" TIMESTAMP(3);

CREATE TABLE "WorkspaceProvision" (
  "labId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createSettled" BOOLEAN NOT NULL DEFAULT false,
  "cleanupAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceProvision_pkey" PRIMARY KEY ("labId")
);
CREATE INDEX "WorkspaceProvision_cleanupAt_idx" ON "WorkspaceProvision"("cleanupAt");

-- Existing CREATING rows may still have an in-flight Labs request during rollout.
UPDATE "Workspace" SET "provisionStartedAt" = "updatedAt" WHERE "status" = 'CREATING';

CREATE INDEX "Workspace_status_resetRetryAt_idx" ON "Workspace"("status", "resetRetryAt");
