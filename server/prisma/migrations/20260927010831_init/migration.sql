-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "passwordHash" TEXT NOT NULL,
    "nickname" TEXT NOT NULL DEFAULT '家长用户',
    "avatar" TEXT NOT NULL DEFAULT '',
    "wechatOpenid" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "activeDeviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChildDevice" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'Unknown',
    "os" TEXT NOT NULL DEFAULT 'Unknown',
    "osVersion" TEXT NOT NULL DEFAULT '',
    "avatar" TEXT NOT NULL DEFAULT '',
    "deviceCode" TEXT NOT NULL,
    "deviceSecretHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "battery" INTEGER NOT NULL DEFAULT 0,
    "network" TEXT NOT NULL DEFAULT 'unknown',
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "tempUnlockUntil" TIMESTAMP(3),
    "agentVersion" TEXT NOT NULL DEFAULT '',
    "lastActiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChildDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceFeature" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimePlan" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dailyLimitMinutes" INTEGER NOT NULL DEFAULT 0,
    "usedTodayMinutes" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppLimit" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "packageName" TEXT NOT NULL DEFAULT '',
    "dailyLimitMinutes" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppAuditRequest" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "packageName" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT NOT NULL DEFAULT '',
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppAuditRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockedUrl" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedUrl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCommand" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "error" TEXT NOT NULL DEFAULT '',
    "requestedBy" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationRecord" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "address" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL DEFAULT 'other',
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafeZone" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "radiusMeters" INTEGER NOT NULL DEFAULT 200,
    "address" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL DEFAULT 'other',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SafeZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizQuestion" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "grade" TEXT NOT NULL DEFAULT 'grade1',
    "question" TEXT NOT NULL,
    "options" TEXT[],
    "correctAnswer" INTEGER NOT NULL,
    "explanation" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizConfig" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "quizType" TEXT NOT NULL DEFAULT 'english',
    "grade" TEXT NOT NULL DEFAULT 'grade1',
    "correctRewardMinutes" INTEGER NOT NULL DEFAULT 3,
    "randomMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuizConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizRecord" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "deviceId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "userAnswer" INTEGER NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "rewardMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsCode" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "commandId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_wechatOpenid_key" ON "User"("wechatOpenid");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ChildDevice_deviceCode_key" ON "ChildDevice"("deviceCode");

-- CreateIndex
CREATE INDEX "ChildDevice_userId_idx" ON "ChildDevice"("userId");

-- CreateIndex
CREATE INDEX "ChildDevice_userId_status_idx" ON "ChildDevice"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceFeature_deviceId_key_key" ON "DeviceFeature"("deviceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "TimePlan_deviceId_key" ON "TimePlan"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "AppLimit_deviceId_appName_key" ON "AppLimit"("deviceId", "appName");

-- CreateIndex
CREATE INDEX "AppAuditRequest_deviceId_status_idx" ON "AppAuditRequest"("deviceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedUrl_deviceId_url_key" ON "BlockedUrl"("deviceId", "url");

-- CreateIndex
CREATE INDEX "DeviceCommand_deviceId_status_idx" ON "DeviceCommand"("deviceId", "status");

-- CreateIndex
CREATE INDEX "DeviceCommand_status_expiresAt_idx" ON "DeviceCommand"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "DeviceCommand_deviceId_createdAt_idx" ON "DeviceCommand"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "LocationRecord_deviceId_recordedAt_idx" ON "LocationRecord"("deviceId", "recordedAt");

-- CreateIndex
CREATE INDEX "SafeZone_deviceId_idx" ON "SafeZone"("deviceId");

-- CreateIndex
CREATE INDEX "QuizQuestion_type_grade_idx" ON "QuizQuestion"("type", "grade");

-- CreateIndex
CREATE UNIQUE INDEX "QuizConfig_deviceId_key" ON "QuizConfig"("deviceId");

-- CreateIndex
CREATE INDEX "QuizRecord_deviceId_createdAt_idx" ON "QuizRecord"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "QuizRecord_userId_createdAt_idx" ON "QuizRecord"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SmsCode_phone_purpose_createdAt_idx" ON "SmsCode"("phone", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "SmsCode_expiresAt_idx" ON "SmsCode"("expiresAt");

-- CreateIndex
CREATE INDEX "MediaAsset_deviceId_createdAt_idx" ON "MediaAsset"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAsset_userId_idx" ON "MediaAsset"("userId");

-- AddForeignKey
ALTER TABLE "ChildDevice" ADD CONSTRAINT "ChildDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceFeature" ADD CONSTRAINT "DeviceFeature_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimePlan" ADD CONSTRAINT "TimePlan_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppLimit" ADD CONSTRAINT "AppLimit_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppAuditRequest" ADD CONSTRAINT "AppAuditRequest_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedUrl" ADD CONSTRAINT "BlockedUrl_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationRecord" ADD CONSTRAINT "LocationRecord_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SafeZone" ADD CONSTRAINT "SafeZone_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizConfig" ADD CONSTRAINT "QuizConfig_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizRecord" ADD CONSTRAINT "QuizRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizRecord" ADD CONSTRAINT "QuizRecord_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizRecord" ADD CONSTRAINT "QuizRecord_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "QuizQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
