-- AlterTable
ALTER TABLE "ChildDevice" ADD COLUMN     "effectiveLocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lockReason" TEXT NOT NULL DEFAULT '';
