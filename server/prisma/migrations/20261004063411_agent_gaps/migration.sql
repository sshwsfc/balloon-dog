-- AlterTable
ALTER TABLE "AppLimit" ADD COLUMN     "usageDay" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "usedTodaySeconds" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ChildDevice" ADD COLUMN     "hideIcon" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "installApprovalUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SafeZone" ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CallLogEntry" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL,
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsMessage" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallLogEntry_deviceId_occurredAt_idx" ON "CallLogEntry"("deviceId", "occurredAt");

-- CreateIndex
CREATE INDEX "SmsMessage_deviceId_occurredAt_idx" ON "SmsMessage"("deviceId", "occurredAt");

-- AddForeignKey
ALTER TABLE "CallLogEntry" ADD CONSTRAINT "CallLogEntry_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsMessage" ADD CONSTRAINT "SmsMessage_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
