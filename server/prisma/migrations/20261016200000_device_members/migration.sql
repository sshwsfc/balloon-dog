-- 家庭成员（规划 §5.1）：一台设备多个家长账号，角色 admin / viewer。
--
-- 设备所有者（ChildDevice.userId）**不在**这张表里 —— 它隐式就是 admin。
-- 否则「所有者那一行被删掉」和「行丢了但设备还在」这两件事都需要额外解释。
CREATE TABLE "DeviceMember" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "nickname" TEXT NOT NULL DEFAULT '',
    "invitedBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceMember_pkey" PRIMARY KEY ("id")
);

-- 同一个人在同一台设备上只能有一条记录（换个角色是 UPDATE 不是 INSERT）
CREATE UNIQUE INDEX "DeviceMember_deviceId_userId_key" ON "DeviceMember"("deviceId", "userId");

-- 「我作为成员能访问哪些设备」要快：resolveDevice 的兜底查询会走这里
CREATE INDEX "DeviceMember_userId_idx" ON "DeviceMember"("userId");

ALTER TABLE "DeviceMember" ADD CONSTRAINT "DeviceMember_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceMember" ADD CONSTRAINT "DeviceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
