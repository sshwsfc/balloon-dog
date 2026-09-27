-- AlterTable
ALTER TABLE "ChildDevice" ADD COLUMN     "boundAt" TIMESTAMP(3),
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "MediaAsset" ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "QuizRecord" ALTER COLUMN "userId" DROP NOT NULL;
