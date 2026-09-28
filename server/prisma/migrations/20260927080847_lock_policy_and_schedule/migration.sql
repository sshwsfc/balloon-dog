-- CreateTable
CREATE TABLE "LockPolicy" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "strength" TEXT NOT NULL DEFAULT 'kiosk',
    "countdownSeconds" INTEGER NOT NULL DEFAULT 30,
    "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LockPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleRule" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL DEFAULT 'lock',
    "daysOfWeek" INTEGER[],
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LockPolicy_deviceId_key" ON "LockPolicy"("deviceId");

-- CreateIndex
CREATE INDEX "ScheduleRule_deviceId_idx" ON "ScheduleRule"("deviceId");

-- AddForeignKey
ALTER TABLE "LockPolicy" ADD CONSTRAINT "LockPolicy_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleRule" ADD CONSTRAINT "ScheduleRule_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
