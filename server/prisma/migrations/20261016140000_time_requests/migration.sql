-- 孩子的「申请」（规划 §3.1）：孩子端发起的加时 / 延后锁屏请求，由家长审批。
--
-- 背景：孩子端此前只有「被锁」和「设置页」，没有任何正向出口 —— 除了等家长什么也做不了，
-- 这是亲子冲突的主要来源（规划 §3 开篇）。服务端已经有完整的设备端申请通道
-- （AppAuditRequest：装应用申请），但「能不能多玩 20 分钟」和「能不能装这个包」
-- 是两种不同的东西：前者有天然的幂等键 (deviceId, kind)，批准后的落地动作是
-- 走 temp_unlock 指令下发一段放行窗口；后者幂等键是包名，落地是 installApprovalUntil。
-- 硬塞进一张表要靠一堆可空字段区分语义，家长端的两个列表也会互相污染。
--
-- 批准不删记录：请假条式的历史要留痕（与 AppAuditRequest 的 reviewAudit 一致）。
CREATE TABLE "TimeRequest" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'extend_time',
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewNote" TEXT NOT NULL DEFAULT '',
    "grantedMinutes" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeRequest_pkey" PRIMARY KEY ("id")
);

-- 孩子端每次进入锁屏页都会问「我这条申请批了吗」，家长端每次都拉一遍待审批列表；
-- 两个方向的查询都落在这两个索引上。另外 status='pending' 的唯一性靠
-- findPendingTimeRequest 在服务层保证（不加数据库唯一索引：历史条目的 status
-- 会从 pending 变成 approved，部分唯一索引在 Prisma 里没法声明式表达）。
CREATE INDEX "TimeRequest_deviceId_status_idx" ON "TimeRequest"("deviceId", "status");
CREATE INDEX "TimeRequest_status_createdAt_idx" ON "TimeRequest"("status", "createdAt");

ALTER TABLE "TimeRequest"
    ADD CONSTRAINT "TimeRequest_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
