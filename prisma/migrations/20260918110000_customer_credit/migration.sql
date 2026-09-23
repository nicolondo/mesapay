-- Venta a crédito por cliente de facturación.
--
--   PaymentMethod.customer_credit → el Payment (approved) que deja la cuenta
--                                   pagada para la mesa sin que entre plata:
--                                   va a cuentas por cobrar (130505).
--   BillingCustomer.credit*       → habilitar crédito, tope (null = sin tope)
--                                   y plazo en días.
--   BillingCustomer.discount*     → descuento comercial fijo del cliente en
--                                   puntos base (1000 = 10 %), se aplica al
--                                   asociar la cuenta al cliente.
--   Payment.billingCustomerId     → a quién se le cobró a crédito.
--   CustomerCreditPayment         → abono del cliente a lo adeudado, con la
--                                   cuenta de dinero donde entró la plata.

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'customer_credit';

-- AlterTable
ALTER TABLE "BillingCustomer" ADD COLUMN "creditEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "creditLimitCents" INTEGER,
ADD COLUMN "creditTermsDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN "discountEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "discountBps" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "billingCustomerId" TEXT;

-- CreateTable
CREATE TABLE "CustomerCreditPayment" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "billingCustomerId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "accountCode" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerCreditPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payment_billingCustomerId_idx" ON "Payment"("billingCustomerId");

-- CreateIndex
CREATE INDEX "CustomerCreditPayment_restaurantId_paidAt_idx" ON "CustomerCreditPayment"("restaurantId", "paidAt");

-- CreateIndex
CREATE INDEX "CustomerCreditPayment_billingCustomerId_idx" ON "CustomerCreditPayment"("billingCustomerId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_billingCustomerId_fkey" FOREIGN KEY ("billingCustomerId") REFERENCES "BillingCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditPayment" ADD CONSTRAINT "CustomerCreditPayment_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditPayment" ADD CONSTRAINT "CustomerCreditPayment_billingCustomerId_fkey" FOREIGN KEY ("billingCustomerId") REFERENCES "BillingCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditPayment" ADD CONSTRAINT "CustomerCreditPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
