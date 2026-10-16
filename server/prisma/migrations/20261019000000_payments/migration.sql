-- AlterTable
ALTER TABLE "MembershipOrder" ADD COLUMN     "notifiedOrderNo" TEXT,
ADD COLUMN     "prepayId" TEXT,
ADD COLUMN     "prepayPayload" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "refundCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundNo" TEXT,
ADD COLUMN     "refundReason" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "signatureOk" BOOLEAN NOT NULL DEFAULT false,
    "result" TEXT NOT NULL DEFAULT '',
    "detail" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceRequest" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "orderNo" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "taxNo" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT NOT NULL DEFAULT '',
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentEvent_orderNo_idx" ON "PaymentEvent"("orderNo");

-- CreateIndex
CREATE INDEX "PaymentEvent_provider_createdAt_idx" ON "PaymentEvent"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentEvent_result_createdAt_idx" ON "PaymentEvent"("result", "createdAt");

-- CreateIndex
CREATE INDEX "InvoiceRequest_userId_status_idx" ON "InvoiceRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "InvoiceRequest_status_createdAt_idx" ON "InvoiceRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "InvoiceRequest_orderNo_idx" ON "InvoiceRequest"("orderNo");

-- CreateIndex
CREATE INDEX "MembershipOrder_prepayId_idx" ON "MembershipOrder"("prepayId");

-- CreateIndex
CREATE INDEX "MembershipOrder_transactionId_idx" ON "MembershipOrder"("transactionId");

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

