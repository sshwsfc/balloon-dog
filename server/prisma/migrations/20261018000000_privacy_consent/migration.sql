-- 合规留痕与注销（规划 §5.3）。
--
-- 三件事需要一个落脚点：
--   1. 「家长同意了什么、哪一版」——同意记录只追加，撤回写 revokedAt 而不是删行；
--   2. 「谁在什么时候导出过什么」——导出也是取证行为，不能没有流水；
--   3. 「账号什么时候真的被删」——注销先进冷静期（User.deletionScheduledAt），到点由定时任务删库。
--
-- 冷静期只用一个时间戳字段表示，不另存 status：状态由「现在几点 / 这个字段空不空」推出来，
-- 两处都存必然对不上（membership 的过期降级、referral 的结算都吃过这个亏）。
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "docType" TEXT NOT NULL,
    "docVersion" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConsentRecord_userId_docType_idx" ON "ConsentRecord"("userId", "docType");

ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PrivacyRequest" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PrivacyRequest_userId_kind_idx" ON "PrivacyRequest"("userId", "kind");

ALTER TABLE "PrivacyRequest" ADD CONSTRAINT "PrivacyRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 注销冷静期的生效时间（null = 没在注销流程里）
ALTER TABLE "User" ADD COLUMN "deletionScheduledAt" TIMESTAMP(3);
