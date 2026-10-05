-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "inputCacheHitTokens" INTEGER,
ADD COLUMN     "inputCacheMissTokens" INTEGER,
ADD COLUMN     "outputTokens" INTEGER;

-- AlterTable
ALTER TABLE "QuotaLedger" ADD COLUMN     "tokensDelta" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "minutesDelta" SET DEFAULT 0;
