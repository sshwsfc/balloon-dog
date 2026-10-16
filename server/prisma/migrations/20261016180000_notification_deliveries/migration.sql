-- 站内通知之外的「再投递一次」记录（规划 §2.1 第二档：微信服务号模板消息）。
--
-- 背景：R1 只做了站内（消息中心 + 未读角标），微信与厂商推送当时**有意留白** ——
-- 接口如实回 configured: false，界面显示「未配置」。这一档把微信服务号模板消息接上，
-- 但「发了没有、为什么没发出去」必须可查：家长问「我为什么没收到微信通知」时，
-- 只说「我们发过了」是不够的（常见原因是没关注公众号、模板 ID 填错、令牌失效）。
--
-- 所以投递单独一张表。刻意不引入队列/调度器：投递在家长打开消息中心
-- （未读角标接口）时惰性派发，和「会员到期懒检查」同一个取舍。
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT NOT NULL DEFAULT '',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- 同一条消息同一个通道只投一次：重试是更新同一行，不是插新行
CREATE UNIQUE INDEX "NotificationDelivery_notificationId_channel_key"
    ON "NotificationDelivery"("notificationId", "channel");

-- 派发时按「还没成功、按时间顺序」取，这两列一起走索引
CREATE INDEX "NotificationDelivery_status_createdAt_idx"
    ON "NotificationDelivery"("status", "createdAt");

ALTER TABLE "NotificationDelivery"
    ADD CONSTRAINT "NotificationDelivery_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "Notification"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
