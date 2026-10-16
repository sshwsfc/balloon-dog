-- 孩子档案 + 今日任务（规划 §5.2）。
--
-- 「孩子」此前不存在，只有设备：双胞胎的两台手机在系统里毫无关联，周报和年龄适配
-- 也没有落脚点。设备通过 ChildDevice.childId 指向孩子（多对一）。
--
-- 删孩子用 SET NULL 而不是 CASCADE：删掉一份档案不该把家长的设备一起删掉，
-- 那等于「整理通讯录顺手删了手机」。
CREATE TABLE "Child" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "birthYear" INTEGER,
    "school" TEXT NOT NULL DEFAULT '',
    "avatar" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Child_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Child_userId_idx" ON "Child"("userId");

ALTER TABLE "Child" ADD CONSTRAINT "Child_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 设备挂到孩子身上
ALTER TABLE "ChildDevice" ADD COLUMN "childId" TEXT;
CREATE INDEX "ChildDevice_childId_idx" ON "ChildDevice"("childId");
ALTER TABLE "ChildDevice" ADD CONSTRAINT "ChildDevice_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 今日任务：挂在孩子身上（同一孩子的多台设备看同一份清单）
CREATE TABLE "ChildTask" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3),
    "createdBy" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChildTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChildTask_childId_date_idx" ON "ChildTask"("childId", "date");
CREATE INDEX "ChildTask_date_idx" ON "ChildTask"("date");

ALTER TABLE "ChildTask" ADD CONSTRAINT "ChildTask_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;
