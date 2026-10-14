-- AlterTable
ALTER TABLE "MembershipOrder" ADD COLUMN     "couponCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "couponId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "idCardHash" TEXT,
ADD COLUMN     "idCardTail" TEXT,
ADD COLUMN     "inviteCode" TEXT,
ADD COLUMN     "realName" TEXT,
ADD COLUMN     "referredAt" TIMESTAMP(3),
ADD COLUMN     "referredById" INTEGER,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ReferralConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "title" TEXT NOT NULL DEFAULT '邀请新用户，返现 50%',
    "subtitle" TEXT NOT NULL DEFAULT '新用户注册充值后，您最高可获得 50% 返现',
    "notice" TEXT NOT NULL DEFAULT '',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "shortPeriodMinRatePercent" INTEGER NOT NULL DEFAULT 50,
    "longPeriodCapCents" INTEGER NOT NULL DEFAULT 7500,
    "renewalRatePercent" INTEGER NOT NULL DEFAULT 20,
    "renewalCapCents" INTEGER NOT NULL DEFAULT 7500,
    "withdrawMinInvitees" INTEGER NOT NULL DEFAULT 3,
    "withdrawMinCents" INTEGER NOT NULL DEFAULT 5000,
    "withdrawRequireVerified" BOOLEAN NOT NULL DEFAULT true,
    "settleDayStart" INTEGER NOT NULL DEFAULT 10,
    "settleDayEnd" INTEGER NOT NULL DEFAULT 15,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralRewardTier" (
    "id" TEXT NOT NULL,
    "minInvitees" INTEGER NOT NULL,
    "maxInvitees" INTEGER,
    "ratePercent" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralRewardTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCouponRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "inviteeCount" INTEGER NOT NULL,
    "repeatEvery" INTEGER,
    "amountCents" INTEGER NOT NULL,
    "validDays" INTEGER NOT NULL DEFAULT 90,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralCouponRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "inviterId" INTEGER NOT NULL,
    "inviteeId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'bound',
    "invalidReason" TEXT NOT NULL DEFAULT '',
    "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralReward" (
    "id" TEXT NOT NULL,
    "rewardNo" TEXT NOT NULL,
    "inviterId" INTEGER NOT NULL,
    "inviteeId" INTEGER NOT NULL,
    "orderNo" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "baseAmountCents" INTEGER NOT NULL,
    "ratePercent" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "capApplied" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "settleMonth" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3),
    "cancelReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralWithdrawal" (
    "id" TEXT NOT NULL,
    "withdrawNo" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "realName" TEXT NOT NULL,
    "idCardTail" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "userNote" TEXT NOT NULL DEFAULT '',
    "reviewNote" TEXT NOT NULL DEFAULT '',
    "reviewedBy" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCoupon" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'milestone',
    "sourceRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unused',
    "expiresAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "usedOrderNo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralCoupon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferralRewardTier_enabled_sortOrder_idx" ON "ReferralRewardTier"("enabled", "sortOrder");

-- CreateIndex
CREATE INDEX "ReferralCouponRule_enabled_sortOrder_idx" ON "ReferralCouponRule"("enabled", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_inviteeId_key" ON "Referral"("inviteeId");

-- CreateIndex
CREATE INDEX "Referral_inviterId_status_idx" ON "Referral"("inviterId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralReward_rewardNo_key" ON "ReferralReward"("rewardNo");

-- CreateIndex
CREATE INDEX "ReferralReward_inviterId_status_idx" ON "ReferralReward"("inviterId", "status");

-- CreateIndex
CREATE INDEX "ReferralReward_inviterId_settleMonth_idx" ON "ReferralReward"("inviterId", "settleMonth");

-- CreateIndex
CREATE INDEX "ReferralReward_orderNo_idx" ON "ReferralReward"("orderNo");

-- CreateIndex
CREATE INDEX "ReferralReward_status_settleMonth_idx" ON "ReferralReward"("status", "settleMonth");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralWithdrawal_withdrawNo_key" ON "ReferralWithdrawal"("withdrawNo");

-- CreateIndex
CREATE INDEX "ReferralWithdrawal_userId_status_idx" ON "ReferralWithdrawal"("userId", "status");

-- CreateIndex
CREATE INDEX "ReferralWithdrawal_status_createdAt_idx" ON "ReferralWithdrawal"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCoupon_sourceRef_key" ON "ReferralCoupon"("sourceRef");

-- CreateIndex
CREATE INDEX "ReferralCoupon_userId_status_idx" ON "ReferralCoupon"("userId", "status");

-- CreateIndex
CREATE INDEX "ReferralCoupon_status_expiresAt_idx" ON "ReferralCoupon"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_inviteCode_key" ON "User"("inviteCode");

-- CreateIndex
CREATE INDEX "User_referredById_idx" ON "User"("referredById");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralWithdrawal" ADD CONSTRAINT "ReferralWithdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCoupon" ADD CONSTRAINT "ReferralCoupon_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

