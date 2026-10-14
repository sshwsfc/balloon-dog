-- AlterTable
ALTER TABLE "User" ADD COLUMN     "firstPaidAt" TIMESTAMP(3),
ADD COLUMN     "membershipAutoRenew" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "membershipExpiresAt" TIMESTAMP(3),
ADD COLUMN     "membershipRenewTier" TEXT,
ADD COLUMN     "membershipStartedAt" TIMESTAMP(3),
ADD COLUMN     "membershipTier" TEXT NOT NULL DEFAULT 'ordinary',
ADD COLUMN     "totalPaidCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "MembershipPlan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "basePriceCents" INTEGER NOT NULL,
    "months" INTEGER NOT NULL DEFAULT 1,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipPricingRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "conditionType" TEXT NOT NULL,
    "conditionMinDevices" INTEGER,
    "conditionDays" INTEGER,
    "conditionFromTier" TEXT,
    "targetTier" TEXT NOT NULL DEFAULT 'all',
    "targetPeriod" TEXT NOT NULL DEFAULT 'all',
    "discountType" TEXT NOT NULL,
    "discountValue" INTEGER NOT NULL,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipPricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipOrder" (
    "id" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "planCode" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "originalCents" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "adjustments" TEXT NOT NULL DEFAULT '[]',
    "payChannel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "transactionId" TEXT,
    "paidAt" TIMESTAMP(3),
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "autoRenew" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MembershipPlan_code_key" ON "MembershipPlan"("code");

-- CreateIndex
CREATE INDEX "MembershipPlan_enabled_sortOrder_idx" ON "MembershipPlan"("enabled", "sortOrder");

-- CreateIndex
CREATE INDEX "MembershipPricingRule_enabled_priority_idx" ON "MembershipPricingRule"("enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipOrder_orderNo_key" ON "MembershipOrder"("orderNo");

-- CreateIndex
CREATE INDEX "MembershipOrder_userId_status_idx" ON "MembershipOrder"("userId", "status");

-- CreateIndex
CREATE INDEX "MembershipOrder_status_createdAt_idx" ON "MembershipOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MembershipOrder_tier_createdAt_idx" ON "MembershipOrder"("tier", "createdAt");

-- CreateIndex
CREATE INDEX "User_membershipTier_membershipExpiresAt_idx" ON "User"("membershipTier", "membershipExpiresAt");

-- AddForeignKey
ALTER TABLE "MembershipOrder" ADD CONSTRAINT "MembershipOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
