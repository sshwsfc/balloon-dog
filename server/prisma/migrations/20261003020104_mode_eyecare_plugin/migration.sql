-- CreateTable
CREATE TABLE "DeviceMode" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "manualMode" TEXT,
    "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceMode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudyModeSlot" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "hour" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudyModeSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModeApp" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "appName" TEXT NOT NULL DEFAULT '',
    "group" TEXT NOT NULL DEFAULT 'study',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModeApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceApp" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "appName" TEXT NOT NULL DEFAULT '',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isLaunchable" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EyeCareConfig" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "continuousMinutes" INTEGER NOT NULL DEFAULT 40,
    "restMinutes" INTEGER NOT NULL DEFAULT 10,
    "nightStartHour" INTEGER NOT NULL DEFAULT 22,
    "nightEndHour" INTEGER NOT NULL DEFAULT 7,
    "nightLockEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxBrightnessPercent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EyeCareConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppPluginState" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "pluginKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppPluginState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceEvent" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceMode_deviceId_key" ON "DeviceMode"("deviceId");

-- CreateIndex
CREATE INDEX "StudyModeSlot_deviceId_idx" ON "StudyModeSlot"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "StudyModeSlot_deviceId_dayOfWeek_hour_key" ON "StudyModeSlot"("deviceId", "dayOfWeek", "hour");

-- CreateIndex
CREATE INDEX "ModeApp_deviceId_idx" ON "ModeApp"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ModeApp_deviceId_packageName_group_key" ON "ModeApp"("deviceId", "packageName", "group");

-- CreateIndex
CREATE INDEX "DeviceApp_deviceId_idx" ON "DeviceApp"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceApp_deviceId_packageName_key" ON "DeviceApp"("deviceId", "packageName");

-- CreateIndex
CREATE UNIQUE INDEX "EyeCareConfig_deviceId_key" ON "EyeCareConfig"("deviceId");

-- CreateIndex
CREATE INDEX "AppPluginState_deviceId_idx" ON "AppPluginState"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "AppPluginState_deviceId_packageName_pluginKey_key" ON "AppPluginState"("deviceId", "packageName", "pluginKey");

-- CreateIndex
CREATE INDEX "DeviceEvent_deviceId_createdAt_idx" ON "DeviceEvent"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceEvent_createdAt_idx" ON "DeviceEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "DeviceMode" ADD CONSTRAINT "DeviceMode_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudyModeSlot" ADD CONSTRAINT "StudyModeSlot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModeApp" ADD CONSTRAINT "ModeApp_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceApp" ADD CONSTRAINT "DeviceApp_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EyeCareConfig" ADD CONSTRAINT "EyeCareConfig_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppPluginState" ADD CONSTRAINT "AppPluginState_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEvent" ADD CONSTRAINT "DeviceEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
