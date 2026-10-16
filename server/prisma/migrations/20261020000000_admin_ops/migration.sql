-- CreateTable
CREATE TABLE "AlertRule" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "severity" TEXT NOT NULL DEFAULT 'warn',
    "threshold" INTEGER NOT NULL,
    "windowMinutes" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AlertAck" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "adminId" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertAck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "ticketNo" TEXT NOT NULL,
    "userId" INTEGER,
    "deviceId" TEXT,
    "contact" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT 'other',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "assigneeId" INTEGER,
    "replies" JSONB NOT NULL DEFAULT '[]',
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimeFlag" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "rolloutPercent" INTEGER NOT NULL DEFAULT 100,
    "allowIds" JSONB NOT NULL DEFAULT '[]',
    "updatedBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimeFlag_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "AlertAck_createdAt_idx" ON "AlertAck"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlertAck_key_subject_key" ON "AlertAck"("key", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_ticketNo_key" ON "SupportTicket"("ticketNo");

-- CreateIndex
CREATE INDEX "SupportTicket_status_createdAt_idx" ON "SupportTicket"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicket_userId_createdAt_idx" ON "SupportTicket"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicket_category_createdAt_idx" ON "SupportTicket"("category", "createdAt");

-- AddForeignKey
ALTER TABLE "AlertAck" ADD CONSTRAINT "AlertAck_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeFlag" ADD CONSTRAINT "RuntimeFlag_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ----------------------------------------------------------------------------
-- 默认告警规则与灰度开关（规划 §5.5）
--
-- 为什么 seed 写在迁移里：生产库升级完就该有一份可用的规则，而不是等第一个管理员
-- 打开后台时才发现「表是空的」。代码里同时有一份 DEFAULT_RULES / FLAG_DEFS 作为契约
-- 与兜底（缺行时按代码默认值求值），两份必须一致 —— 由 server:e2e:alerts / :flags 断言。
-- ----------------------------------------------------------------------------

INSERT INTO "AlertRule" ("key", "label", "enabled", "severity", "threshold", "windowMinutes", "note", "updatedAt") VALUES
  ('device_offline',  '设备失联率',   true, 'danger', 30, 0,  '失联 + 严重失联占已绑定设备的比例。分母不含未认领设备，也不含「从未连接」', CURRENT_TIMESTAMP),
  ('control_gap',     '管控失效率',   true, 'warn',   30, 0,  '有健康快照且存在管控缺口（缺口清单非空或守护服务未运行）的设备占比', CURRENT_TIMESTAMP),
  ('command_failure', '指令失败率',   true, 'warn',   20, 60, '窗口内失败 + 超时未领取的指令占比', CURRENT_TIMESTAMP),
  ('payment_anomaly', '支付异常',     true, 'danger',  1, 60, '窗口内异常支付事件条数（坏签名 / 金额不符 / 未知单 / 处理错误）', CURRENT_TIMESTAMP),
  ('notify_failure',  '通知投递失败', true, 'warn',    5, 60, '窗口内重试到上限仍失败的微信模板消息条数', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RuntimeFlag" ("key", "label", "description", "enabled", "rolloutPercent", "allowIds", "updatedAt") VALUES
  ('pay.channel.wechat',      '微信支付渠道',     '按账号放量：关掉后家长端目录里不再出现微信支付（已下单的订单不受影响）', true, 100, '[]', CURRENT_TIMESTAMP),
  ('pay.channel.alipay',      '支付宝支付渠道',   '按账号放量：想先让 10% 的账号试支付宝就把它调到 10', true, 100, '[]', CURRENT_TIMESTAMP),
  ('pay.refund.selfservice',  '家长自助退款',     '全局开关：关掉后家长端只能联系客服退款，后台人工退款不受影响', true, 100, '[]', CURRENT_TIMESTAMP),
  ('notify.wechat.dispatch',  '微信模板消息投递', '全局开关：关掉后模板消息不再出站（站内通知不受影响）', true, 100, '[]', CURRENT_TIMESTAMP),
  ('support.tickets',         '客服工单入口',     '全局开关：关掉后家长端不再提供工单入口、提交返回 503，历史工单仍可在后台查看', true, 100, '[]', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
