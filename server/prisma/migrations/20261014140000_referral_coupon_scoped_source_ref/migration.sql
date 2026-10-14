-- DropIndex
DROP INDEX "ReferralCoupon_sourceRef_key";

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCoupon_userId_sourceRef_key" ON "ReferralCoupon"("userId", "sourceRef");

