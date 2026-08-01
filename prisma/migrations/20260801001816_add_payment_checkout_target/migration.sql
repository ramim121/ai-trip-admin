-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "itineraryId" UUID,
ADD COLUMN     "planId" UUID;

-- CreateIndex
CREATE INDEX "payments_itineraryId_idx" ON "payments"("itineraryId");

-- CreateIndex
CREATE INDEX "payments_planId_idx" ON "payments"("planId");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_itineraryId_fkey" FOREIGN KEY ("itineraryId") REFERENCES "itineraries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
