-- 受邀定价从「打折」翻转为「上浮」。
--
-- 语义变了但字段本身还在，所以用 RENAME 而不是 DROP+ADD（后者会丢列且 NOT NULL 加不上去）。
-- 起因：邀请人要拿分享返现（最高 50%，平台出），这笔成本必须落在被邀请家长的订单上，
-- 所以关联公式从 min 改成 max —— 被邀请的用户价格只会**不低于**常规定价。
ALTER TABLE "MembershipReferralPriceRule" RENAME COLUMN "discountType" TO "priceType";
ALTER TABLE "MembershipReferralPriceRule" RENAME COLUMN "discountValue" TO "priceValue";

-- 订单快照字段同理：记的是「比常规定价多收了多少」。
ALTER TABLE "MembershipOrder" RENAME COLUMN "referralDiscountCents" TO "referralSurchargeCents";

-- 旧值是折扣口径（percent 10 = 减免 10%），当成上浮百分比会算出一个明显偏低的加价。
-- 本特性尚未上线，库里只可能有 seed 灌进去的默认行，直接清空并交给
-- ensureDefaults（下次启动 / db:seed）按新的上浮默认值重灌。
DELETE FROM "MembershipReferralPriceRule";
