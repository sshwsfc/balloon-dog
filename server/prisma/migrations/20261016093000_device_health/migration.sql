-- 设备健康快照（规划 §1，家长端「孩子端权限开启情况」的落地表）。
--
-- 背景：孩子端的管控能力全都压在两三个开关上（设备所有者 / 无障碍看门狗 / 特权授权 /
-- 电池白名单 / VPN 授权）。关掉任何一个，对应功能就静默失效，而家长端此前只看得到
-- 「在线 + 电量」。设备端本来就能算出这份清单（LongevityGuard.problems()），
-- 缺的只是一条上报通道。
--
-- 一份快照一行（deviceId 唯一），语义是整份覆盖而不是流水：
-- 「此刻哪几项坏了」必须一眼可读，不能靠翻历史去猜。
CREATE TABLE "DeviceHealth" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'warn',
    "gaps" JSONB NOT NULL DEFAULT '[]',
    "openGaps" INTEGER NOT NULL DEFAULT 0,
    "checks" JSONB NOT NULL DEFAULT '{}',
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "restrictions" JSONB NOT NULL DEFAULT '[]',
    "serviceRunning" BOOLEAN NOT NULL DEFAULT false,
    "clockSkewSeconds" INTEGER NOT NULL DEFAULT 0,
    "healCount" INTEGER NOT NULL DEFAULT 0,
    "lastHealAt" TIMESTAMP(3),
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceHealth_pkey" PRIMARY KEY ("id")
);

-- 一台设备只有一份快照：上报走 upsert，读走 findUnique，两边都靠这个唯一索引兜底。
CREATE UNIQUE INDEX "DeviceHealth_deviceId_key" ON "DeviceHealth"("deviceId");

ALTER TABLE "DeviceHealth"
    ADD CONSTRAINT "DeviceHealth_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
