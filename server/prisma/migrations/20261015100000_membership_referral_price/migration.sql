-- AlterTable
ALTER TABLE "MembershipOrder" ADD COLUMN     "referralDiscountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "referralRuleId" TEXT,
ADD COLUMN     "referralRuleName" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "MembershipReferralPriceRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetTier" TEXT NOT NULL DEFAULT 'all',
    "targetPeriod" TEXT NOT NULL DEFAULT 'all',
    "discountType" TEXT NOT NULL,
    "discountValue" INTEGER NOT NULL,
    "firstPurchaseOnly" BOOLEAN NOT NULL DEFAULT true,
    "requireActiveReferral" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipReferralPriceRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MembershipReferralPriceRule_enabled_priority_idx" ON "MembershipReferralPriceRule"("enabled", "priority");

