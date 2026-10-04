-- CreateTable
CREATE TABLE "ScreenMonitorConfig" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "captureEnabled" BOOLEAN NOT NULL DEFAULT false,
    "captureIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
    "framesPerBatch" INTEGER NOT NULL DEFAULT 10,
    "analyzeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "analyzeSampleCount" INTEGER NOT NULL DEFAULT 6,
    "retentionDays" INTEGER NOT NULL DEFAULT 7,
    "quizFromScreen" BOOLEAN NOT NULL DEFAULT false,
    "alertMinorContent" BOOLEAN NOT NULL DEFAULT true,
    "alertScam" BOOLEAN NOT NULL DEFAULT true,
    "alertEmotional" BOOLEAN NOT NULL DEFAULT true,
    "alertGameAddiction" BOOLEAN NOT NULL DEFAULT true,
    "alertHighSpending" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreenMonitorConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreenBatch" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "expectedFrames" INTEGER NOT NULL DEFAULT 0,
    "actualFrames" INTEGER NOT NULL DEFAULT 0,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "storagePath" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failReason" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "analysisMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScreenBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreenFrame" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "packageName" TEXT NOT NULL DEFAULT '',
    "storagePath" TEXT NOT NULL DEFAULT '',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ScreenFrame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreenInsight" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "activities" JSONB,
    "games" JSONB,
    "videos" JSONB,
    "contentFlags" JSONB,
    "topics" JSONB,
    "keywords" TEXT[],
    "riskLevel" TEXT NOT NULL DEFAULT 'none',
    "provider" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT NOT NULL DEFAULT '',
    "rawJson" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScreenInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageAlert" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "insightId" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "evidence" TEXT NOT NULL DEFAULT '',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEpisode" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "insightId" TEXT,
    "kind" TEXT NOT NULL,
    "appName" TEXT NOT NULL DEFAULT '',
    "packageName" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 1,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "evidence" TEXT NOT NULL DEFAULT '',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "dayKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageBudget" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "appName" TEXT NOT NULL DEFAULT '',
    "dailyLimit" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreenQuizQuestion" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "insightId" TEXT,
    "grade" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" TEXT[],
    "correctAnswer" INTEGER NOT NULL,
    "explanation" TEXT NOT NULL DEFAULT '',
    "sourceTerm" TEXT NOT NULL DEFAULT '',
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScreenQuizQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScreenMonitorConfig_deviceId_key" ON "ScreenMonitorConfig"("deviceId");

-- CreateIndex
CREATE INDEX "ScreenBatch_deviceId_startedAt_idx" ON "ScreenBatch"("deviceId", "startedAt");

-- CreateIndex
CREATE INDEX "ScreenBatch_status_createdAt_idx" ON "ScreenBatch"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ScreenFrame_batchId_seq_idx" ON "ScreenFrame"("batchId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ScreenInsight_batchId_key" ON "ScreenInsight"("batchId");

-- CreateIndex
CREATE INDEX "ScreenInsight_deviceId_createdAt_idx" ON "ScreenInsight"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "ScreenInsight_riskLevel_createdAt_idx" ON "ScreenInsight"("riskLevel", "createdAt");

-- CreateIndex
CREATE INDEX "UsageAlert_deviceId_createdAt_idx" ON "UsageAlert"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageAlert_deviceId_readAt_idx" ON "UsageAlert"("deviceId", "readAt");

-- CreateIndex
CREATE INDEX "UsageAlert_type_createdAt_idx" ON "UsageAlert"("type", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEpisode_deviceId_dayKey_kind_idx" ON "UsageEpisode"("deviceId", "dayKey", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "UsageBudget_deviceId_kind_appName_key" ON "UsageBudget"("deviceId", "kind", "appName");

-- CreateIndex
CREATE INDEX "ScreenQuizQuestion_deviceId_grade_usedAt_idx" ON "ScreenQuizQuestion"("deviceId", "grade", "usedAt");

-- AddForeignKey
ALTER TABLE "ScreenMonitorConfig" ADD CONSTRAINT "ScreenMonitorConfig_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreenBatch" ADD CONSTRAINT "ScreenBatch_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreenFrame" ADD CONSTRAINT "ScreenFrame_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ScreenBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreenInsight" ADD CONSTRAINT "ScreenInsight_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ScreenBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreenInsight" ADD CONSTRAINT "ScreenInsight_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageAlert" ADD CONSTRAINT "UsageAlert_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageAlert" ADD CONSTRAINT "UsageAlert_insightId_fkey" FOREIGN KEY ("insightId") REFERENCES "ScreenInsight"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEpisode" ADD CONSTRAINT "UsageEpisode_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEpisode" ADD CONSTRAINT "UsageEpisode_insightId_fkey" FOREIGN KEY ("insightId") REFERENCES "ScreenInsight"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageBudget" ADD CONSTRAINT "UsageBudget_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreenQuizQuestion" ADD CONSTRAINT "ScreenQuizQuestion_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ChildDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
