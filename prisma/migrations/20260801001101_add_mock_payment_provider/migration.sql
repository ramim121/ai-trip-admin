-- AlterEnum
ALTER TYPE "PaymentProvider" ADD VALUE 'MOCK';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "payments_isTest_createdAt_idx" ON "payments"("isTest", "createdAt");
