-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "KushkiOnboardingStatus" AS ENUM ('not_started', 'docs_uploaded', 'submitted', 'in_review', 'active', 'rejected', 'suspended');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('trial', 'basic', 'pro');

-- CreateEnum
CREATE TYPE "ServiceMode" AS ENUM ('table', 'counter');

-- CreateEnum
CREATE TYPE "MembershipMethod" AS ENUM ('manual_cash', 'manual_transfer', 'wompi', 'kushki_card');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('customer', 'operator', 'platform_admin', 'terminal', 'mesero', 'kitchen', 'bar', 'group_admin', 'comercial', 'gerente_comercial');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('pending', 'paid', 'reversed');

-- CreateEnum
CREATE TYPE "TableShape" AS ENUM ('square', 'round', 'bar');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show');

-- CreateEnum
CREATE TYPE "ReservationSource" AS ENUM ('direct', 'google_maps', 'whatsapp', 'phone');

-- CreateEnum
CREATE TYPE "CategoryKind" AS ENUM ('starter', 'main', 'side', 'drink', 'dessert', 'other');

-- CreateEnum
CREATE TYPE "PrepStation" AS ENUM ('kitchen', 'bar', 'counter');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('open', 'placed', 'in_kitchen', 'ready', 'served', 'paying', 'paid', 'cancelled');

-- CreateEnum
CREATE TYPE "KitchenState" AS ENUM ('placed', 'in_kitchen', 'ready');

-- CreateEnum
CREATE TYPE "ServingMode" AS ENUM ('asReady', 'together');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('dineIn', 'pickup');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('demo_card', 'demo_cash', 'wompi_card', 'wompi_pse', 'wompi_nequi', 'kushki_apple_pay', 'kushki_google_pay', 'kushki_card_terminal', 'external_terminal', 'kushki_pse', 'kushki_card', 'reservation_deposit');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('none', 'pending', 'paid', 'applied', 'forfeited', 'refunded');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'approved', 'declined', 'refunded');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "CashMovementKind" AS ENUM ('egreso', 'ingreso');

-- CreateEnum
CREATE TYPE "MeasureKind" AS ENUM ('mass', 'volume', 'count');

-- CreateEnum
CREATE TYPE "StockMovementKind" AS ENUM ('purchase_in', 'adjust_in', 'adjust_out', 'count_adjust', 'waste', 'sale_consumption', 'transfer_in', 'transfer_out', 'production_in', 'production_out');

-- CreateEnum
CREATE TYPE "WasteReason" AS ENUM ('expired', 'damaged', 'kitchen_error', 'spill', 'other');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('draft', 'closed');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('draft', 'sent', 'partially_received', 'received', 'canceled');

-- CreateEnum
CREATE TYPE "KushkiDocumentKind" AS ENUM ('cedula_rep_legal', 'rut', 'camara_comercio', 'bank_cert', 'origen_fondos', 'estados_financieros', 'estatutos', 'other');

-- CreateEnum
CREATE TYPE "KushkiDocumentStatus" AS ENUM ('pending', 'verified', 'rejected');

-- CreateEnum
CREATE TYPE "KushkiTransactionKind" AS ENUM ('charge', 'refund', 'dispersion', 'fee');

-- CreateEnum
CREATE TYPE "KushkiTransactionStatus" AS ENUM ('pending', 'approved', 'declined', 'reversed');

-- CreateEnum
CREATE TYPE "WalletMovementKind" AS ENUM ('credit', 'debit', 'fee', 'dispersion', 'adjustment');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('initialized', 'approved', 'declined', 'failed');

-- CreateEnum
CREATE TYPE "InvoiceDocType" AS ENUM ('CC', 'CE', 'NIT', 'PA');

-- CreateEnum
CREATE TYPE "InvoiceRequestStatus" AS ENUM ('pending', 'generated', 'rejected');

-- CreateEnum
CREATE TYPE "CrmStage" AS ENUM ('nuevo', 'contactado', 'demo_agendada', 'demo_realizada', 'propuesta_enviada', 'negociacion', 'ganado', 'perdido');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('activo', 'pasivo', 'patrimonio', 'ingreso', 'gasto', 'costo');

-- CreateEnum
CREATE TYPE "LedgerAccountNature" AS ENUM ('debito', 'credito');

-- CreateTable
CREATE TABLE "Restaurant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "groupId" TEXT,
    "legalEntityId" TEXT,
    "menuMode" TEXT NOT NULL DEFAULT 'independent',
    "plan" "Plan" NOT NULL DEFAULT 'trial',
    "monthlyPriceCents" INTEGER NOT NULL DEFAULT 0,
    "periodEndsAt" TIMESTAMP(3),
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "lastReminderSentAt" TIMESTAMP(3),
    "lastReminderKind" TEXT,
    "walkoutDangerMinutes" INTEGER NOT NULL DEFAULT 20,
    "serviceMode" "ServiceMode" NOT NULL DEFAULT 'table',
    "pickupEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pickupHours" JSONB,
    "pickupMaxEtaMinutes" INTEGER DEFAULT 45,
    "kushkiMerchantId" TEXT,
    "kushkiPublicKey" TEXT,
    "kushkiPrivateKeyEnc" TEXT,
    "kushkiWebhookSecretEnc" TEXT,
    "kushkiPayoutPublicKey" TEXT,
    "kushkiPayoutPrivateKeyEnc" TEXT,
    "cloudTerminalBusinessCode" TEXT,
    "kushkiMode" TEXT,
    "kushkiCard3ds" BOOLEAN NOT NULL DEFAULT true,
    "aiInsightsEnabled" BOOLEAN,
    "aiDailyMessageLimit" INTEGER,
    "kushkiOnboardingStatus" "KushkiOnboardingStatus" NOT NULL DEFAULT 'not_started',
    "kushkiOnboardingNotes" TEXT,
    "kushkiSubmittedAt" TIMESTAMP(3),
    "kushkiActivatedAt" TIMESTAMP(3),
    "bankInfo" JSONB,
    "autoDispersePolicy" JSONB,
    "menuTags" JSONB,
    "enabledPaymentMethods" JSONB,
    "enabledModules" JSONB,
    "reservationsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reservationConfig" JSONB,
    "floorPlan" JSONB,
    "reservationDepositMethods" JSONB,
    "hasBar" BOOLEAN NOT NULL DEFAULT false,
    "barSubStations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kitchenPrintEnabled" BOOLEAN NOT NULL DEFAULT false,
    "barPrintEnabled" BOOLEAN NOT NULL DEFAULT false,
    "printPaperWidthMm" INTEGER NOT NULL DEFAULT 80,
    "logoUrl" TEXT,
    "legalName" TEXT,
    "taxId" TEXT,
    "legalAddress" TEXT,
    "legalCity" TEXT,
    "legalPhone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "country" TEXT,
    "countryName" TEXT,
    "placeId" TEXT,
    "dianResolution" TEXT,
    "dianResolutionFrom" INTEGER,
    "dianResolutionTo" INTEGER,
    "dianResolutionDate" TIMESTAMP(3),
    "invoicePrefix" TEXT,
    "invoiceNextNumber" INTEGER NOT NULL DEFAULT 1,
    "tipPolicy" TEXT NOT NULL DEFAULT 'shared',
    "staffStrictAttendance" BOOLEAN NOT NULL DEFAULT false,
    "staffHolidayPct" INTEGER NOT NULL DEFAULT 75,
    "staffSundayPct" INTEGER NOT NULL DEFAULT 75,
    "staffHoursDivisor" INTEGER NOT NULL DEFAULT 240,
    "payrollParams" JSONB,
    "purchaseIvaDeductible" BOOLEAN NOT NULL DEFAULT false,
    "salesTaxKind" TEXT NOT NULL DEFAULT 'none',
    "salesTaxPct" INTEGER NOT NULL DEFAULT 0,
    "compEnabled" BOOLEAN NOT NULL DEFAULT true,
    "compLabel" TEXT,
    "inventoryExcludedCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "shiftPolicy" TEXT NOT NULL DEFAULT 'global',
    "businessDayCutoffHour" INTEGER NOT NULL DEFAULT 5,
    "meseroShiftWithoutLocal" TEXT NOT NULL DEFAULT 'block',
    "salesRepUserId" TEXT,
    "salesRepCommissionBps" INTEGER,

    CONSTRAINT "Restaurant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalEntity" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxId" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "phone" TEXT,
    "dianResolution" TEXT,
    "dianResolutionFrom" INTEGER,
    "dianResolutionTo" INTEGER,
    "dianResolutionDate" TIMESTAMP(3),
    "invoicePrefix" TEXT,
    "invoiceNextNumber" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanConfig" (
    "id" TEXT NOT NULL,
    "tier" "Plan" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "defaultPriceCents" INTEGER NOT NULL DEFAULT 0,
    "features" JSONB NOT NULL DEFAULT '[]',
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "kushkiMode" TEXT NOT NULL DEFAULT 'mock',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "aiDailyMessageLimit" INTEGER NOT NULL DEFAULT 50,
    "salesCommissionBps" INTEGER NOT NULL DEFAULT 1000,
    "kushkiBillingPublicKey" TEXT,
    "kushkiBillingPrivateKeyEnc" TEXT,
    "kushkiBillingWebhookSecretEnc" TEXT,

    CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "actorEmail" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "restaurantId" TEXT,
    "kind" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "summary" TEXT NOT NULL,
    "diff" JSONB,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipPayment" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" "MembershipMethod" NOT NULL,
    "note" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "recordedByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerRef" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'manual',

    CONSTRAINT "MembershipPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSubscription" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'kushki',
    "kushkiSubscriptionId" TEXT,
    "plan" "Plan" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "cardExpMonth" INTEGER,
    "cardExpYear" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodEnd" TIMESTAMP(3),
    "nextChargeAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionEntry" (
    "id" TEXT NOT NULL,
    "salesRepUserId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "membershipPaymentId" TEXT NOT NULL,
    "baseAmountCents" INTEGER NOT NULL,
    "bps" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "CommissionStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "paidNote" TEXT,

    CONSTRAINT "CommissionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'customer',
    "restaurantId" TEXT,
    "groupId" TEXT,
    "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
    "welcomedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedTableNumbers" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "commissionBps" INTEGER,
    "disabledAt" TIMESTAMP(3),
    "countryCode" TEXT,
    "managerId" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Table" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "label" TEXT,
    "qrToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "waiterCalledAt" TIMESTAMP(3),
    "waiterAckedAt" TIMESTAMP(3),
    "capacity" INTEGER NOT NULL DEFAULT 4,
    "minConsumptionCents" INTEGER,
    "shape" "TableShape" NOT NULL DEFAULT 'square',
    "reservable" BOOLEAN NOT NULL DEFAULT true,
    "floorPlanX" INTEGER,
    "floorPlanY" INTEGER,
    "reservationDepositCents" INTEGER,

    CONSTRAINT "Table_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerPhone" TEXT,
    "partySize" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'pending',
    "source" "ReservationSource" NOT NULL DEFAULT 'direct',
    "notes" TEXT,
    "confirmationCode" TEXT NOT NULL,
    "internalLog" JSONB,
    "depositCents" INTEGER,
    "depositStatus" "DepositStatus" NOT NULL DEFAULT 'none',
    "depositMethod" "PaymentMethod",
    "depositTxId" TEXT,
    "holdExpiresAt" TIMESTAMP(3),
    "appliedOrderId" TEXT,
    "depositPaymentId" TEXT,
    "locale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Menu" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Menu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "menuId" TEXT,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "kind" "CategoryKind" NOT NULL DEFAULT 'other',
    "prepStation" "PrepStation" NOT NULL DEFAULT 'kitchen',
    "barSubStation" TEXT,
    "parentId" TEXT,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceCents" INTEGER NOT NULL,
    "tags" TEXT[],
    "photoUrl" TEXT,
    "modifiers" JSONB,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "prepMinutes" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "prepStation" "PrepStation",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "customerId" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'open',
    "shortCode" TEXT NOT NULL,
    "diners" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "locale" TEXT,
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "tipCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "servingMode" "ServingMode" NOT NULL DEFAULT 'asReady',
    "orderType" "OrderType" NOT NULL DEFAULT 'dineIn',
    "etaMinutes" INTEGER,
    "readyEta" TIMESTAMP(3),
    "pickupName" TEXT,
    "pickupPhone" TEXT,
    "customerEmail" TEXT,
    "needsWaiter" BOOLEAN NOT NULL DEFAULT false,
    "waiterCalledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "placedAt" TIMESTAMP(3),
    "servedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "compedAt" TIMESTAMP(3),
    "compNote" TEXT,
    "compLabel" TEXT,
    "compAmountCents" INTEGER,
    "stockConsumedAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Round" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'placed',
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kitchenStartedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledByEmail" TEXT,
    "cancellationReason" TEXT,
    "cancellationAckedAt" TIMESTAMP(3),
    "cancellationAckedByEmail" TEXT,

    CONSTRAINT "Round_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "roundId" TEXT,
    "menuItemId" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "nameSnapshot" TEXT NOT NULL,
    "priceCentsSnapshot" INTEGER NOT NULL,
    "taxKind" TEXT,
    "taxPct" INTEGER,
    "modifierSelections" JSONB,
    "notes" TEXT,
    "guestName" TEXT,
    "kitchenStatus" "KitchenState" NOT NULL DEFAULT 'placed',
    "categoryKind" "CategoryKind" NOT NULL DEFAULT 'other',
    "station" "PrepStation" NOT NULL DEFAULT 'kitchen',
    "barSubStation" TEXT,
    "prepMinutesSnapshot" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "preparationStartedAt" TIMESTAMP(3),
    "servedAt" TIMESTAMP(3),
    "expediteRequestedAt" TIMESTAMP(3),
    "expediteRequestedByEmail" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "cancelledByEmail" TEXT,
    "cancellationKind" TEXT,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DishRating" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "comment" TEXT,
    "guestName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DishRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "amountCents" INTEGER NOT NULL,
    "tipCents" INTEGER NOT NULL DEFAULT 0,
    "splitOfCount" INTEGER,
    "providerRef" TEXT,
    "cashTenderCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "refundedAt" TIMESTAMP(3),
    "shiftId" TEXT,
    "collectedByUserId" TEXT,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'open',
    "userId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedById" TEXT NOT NULL,
    "openingCashCents" INTEGER NOT NULL,
    "autoOpened" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "declaredCashCents" INTEGER,
    "expectedCashCents" INTEGER,
    "cashDiffCents" INTEGER,
    "notes" TEXT,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "shiftId" TEXT,
    "kind" "CashMovementKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "concept" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ingredient" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "measureKind" "MeasureKind" NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "reorderPointBase" INTEGER,
    "reorderQtyBase" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxId" TEXT,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "paymentTermsDays" INTEGER,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierIngredient" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "presentationLabel" TEXT NOT NULL,
    "contentQty" INTEGER NOT NULL,
    "lastPriceCents" INTEGER,
    "supplierSku" TEXT,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLevel" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "qtyBase" INTEGER NOT NULL DEFAULT 0,
    "totalValueCents" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "kind" "StockMovementKind" NOT NULL,
    "qtyBase" INTEGER NOT NULL,
    "valueCents" INTEGER NOT NULL,
    "wasteReason" "WasteReason",
    "note" TEXT,
    "stockCountId" TEXT,
    "purchaseOrderId" TEXT,
    "orderId" TEXT,
    "productionBatchId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountItem" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "expectedQty" INTEGER NOT NULL,
    "countedQty" INTEGER,

    CONSTRAINT "StockCountItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "expectedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "supplierInvoiceNumber" TEXT,
    "invoiceDueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paymentNote" TEXT,
    "paidCents" INTEGER NOT NULL DEFAULT 0,
    "discountPct" INTEGER,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "incCents" INTEGER NOT NULL DEFAULT 0,
    "retefuenteCents" INTEGER NOT NULL DEFAULT 0,
    "reteIvaCents" INTEGER NOT NULL DEFAULT 0,
    "reteIcaCents" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderItem" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "supplierItemId" TEXT,
    "qtyOrderedBase" INTEGER NOT NULL,
    "presentations" INTEGER,
    "listCostCents" INTEGER,
    "discountPct" INTEGER,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "orderDiscountCents" INTEGER NOT NULL DEFAULT 0,
    "expectedCostCents" INTEGER NOT NULL,
    "taxPct" INTEGER NOT NULL DEFAULT 0,
    "receivedQtyBase" INTEGER NOT NULL DEFAULT 0,
    "receivedCostCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchasePayment" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchasePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPriceHistory" (
    "id" TEXT NOT NULL,
    "supplierItemId" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "menuItemId" TEXT,
    "outputIngredientId" TEXT,
    "outputQtyBase" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeItem" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "qtyBase" INTEGER NOT NULL,
    "wastePct" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecipeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModifierRecipeItem" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "modifierId" TEXT NOT NULL,
    "optLabel" TEXT NOT NULL,
    "qtyBase" INTEGER NOT NULL,
    "wastePct" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ModifierRecipeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionBatch" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "outputIngredientId" TEXT NOT NULL,
    "outputQtyBase" INTEGER NOT NULL,
    "costCents" INTEGER NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "monthlySalaryCents" INTEGER,
    "hourlyRateCents" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "userId" TEXT,
    "weeklyTemplate" JSONB,
    "faceDescriptors" JSONB,
    "facePhotoUrls" JSONB,
    "faceConsentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "conceptKey" TEXT NOT NULL,
    "conceptLabel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,

    CONSTRAINT "PayrollItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffShift" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "startMinutes" INTEGER NOT NULL,
    "endMinutes" INTEGER NOT NULL,
    "note" TEXT,
    "checkInAt" TIMESTAMP(3),
    "checkOutAt" TIMESTAMP(3),
    "checkInPhotoUrl" TEXT,
    "checkOutPhotoUrl" TEXT,
    "checkInMethod" TEXT,
    "checkOutMethod" TEXT,
    "autoClosed" BOOLEAN NOT NULL DEFAULT false,
    "reviewNeededAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseInvoiceUpload" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "extraction" JSONB NOT NULL,
    "purchaseOrderId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseInvoiceUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DianConfig" (
    "id" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "restaurantId" TEXT,
    "certP12Enc" BYTEA,
    "certPasswordEnc" TEXT,
    "certSubject" TEXT,
    "certNotAfter" TIMESTAMP(3),
    "softwareId" TEXT,
    "softwarePinEnc" TEXT,
    "technicalKey" TEXT,
    "testSetId" TEXT,
    "environment" TEXT NOT NULL DEFAULT 'habilitacion',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DianConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DianDocument" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "simpleInvoiceId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'invoice',
    "state" TEXT NOT NULL DEFAULT 'to_send',
    "cufe" TEXT,
    "xmlZip" BYTEA,
    "responseXml" TEXT,
    "trackId" TEXT,
    "errors" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DianDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "amountCents" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "supplierId" TEXT,
    "costCenterId" TEXT,
    "accountCode" TEXT,
    "dueAt" TIMESTAMP(3),
    "paidCents" INTEGER NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMP(3),
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "recurringDay" INTEGER,
    "templateId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KushkiDocument" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "uploadedById" TEXT,
    "kind" "KushkiDocumentKind" NOT NULL,
    "status" "KushkiDocumentStatus" NOT NULL DEFAULT 'pending',
    "fileUrl" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "extractedFields" JSONB,
    "reviewNotes" TEXT,
    "sftpUploadedAt" TIMESTAMP(3),
    "sftpError" TEXT,
    "sftpAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KushkiDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KushkiTransaction" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "paymentId" TEXT,
    "kushkiTxId" TEXT NOT NULL,
    "kind" "KushkiTransactionKind" NOT NULL,
    "status" "KushkiTransactionStatus" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "raw" JSONB NOT NULL,
    "message" TEXT,
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "cardType" TEXT,
    "cardBin" TEXT,
    "cardHolderName" TEXT,
    "approvalCode" TEXT,
    "processorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KushkiTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletMovement" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "kind" "WalletMovementKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "balanceAfterCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "kushkiRef" TEXT,
    "description" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "toOwnAccount" BOOLEAN NOT NULL DEFAULT false,
    "bankName" TEXT NOT NULL,
    "bankId" TEXT,
    "accountType" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'initialized',
    "providerRef" TEXT,
    "ticketNumber" TEXT,
    "reference" TEXT,
    "responseText" TEXT,
    "createdByEmail" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerminalDevice" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "kushkiDeviceId" TEXT NOT NULL,
    "serialNumber" TEXT,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "assignedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminalDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KushkiWebhookEvent" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KushkiWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimpleInvoice" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "email" TEXT,
    "invoiceNumber" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "emailedAt" TIMESTAMP(3),
    "emailError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimpleInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceRequest" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "docType" "InvoiceDocType" NOT NULL,
    "docNumber" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "placeId" TEXT,
    "rawComponents" JSONB,
    "status" "InvoiceRequestStatus" NOT NULL DEFAULT 'pending',
    "generatedAt" TIMESTAMP(3),
    "generatedByEmail" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Translation" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'machine',
    "sourceHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Translation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiConversation" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT,
    "groupId" TEXT,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Nueva conversación',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchEvent" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "rawTerm" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "hadResults" BOOLEAN NOT NULL,
    "locale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmLead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "cityId" TEXT,
    "address" TEXT,
    "zone" TEXT,
    "businessType" TEXT,
    "stage" "CrmStage" NOT NULL DEFAULT 'nuevo',
    "priority" TEXT NOT NULL DEFAULT 'b',
    "source" TEXT,
    "planProposed" TEXT,
    "unitsCount" INTEGER,
    "unitNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assignedToUserId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "nextActionAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "lostReason" TEXT,
    "notes" TEXT,
    "restaurantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmContact" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,

    CONSTRAINT "CrmContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmActivity" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmAppointment" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "remindedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'scheduled',

    CONSTRAINT "CrmAppointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmDocument" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "ownerUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmEmailTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "attachmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scope" TEXT NOT NULL DEFAULT 'global',
    "ownerUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmEmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWhatsappTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "ownerUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmWhatsappTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmEmailAccount" (
    "userId" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL,
    "smtpUser" TEXT NOT NULL,
    "smtpPassEnc" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "CrmEmailAccount_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "CrmCountry" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL DEFAULT 'COP',

    CONSTRAINT "CrmCountry_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "CrmCity" (
    "id" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isMain" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CrmCity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "nature" "LedgerAccountNature" NOT NULL,
    "level" INTEGER NOT NULL,
    "parentCode" TEXT,
    "postable" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "memo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "voucherNumber" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingConfig" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "uvtCents" INTEGER NOT NULL DEFAULT 5237400,
    "closedThrough" TEXT,
    "nextVoucherNumber" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxFiling" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "declaredCents" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "entryId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxFiling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostCenter" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostCenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "accountCode" TEXT NOT NULL,
    "monthlyCents" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatementLine" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "entryId" TEXT,
    "importBatch" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankRecRule" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankRecRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedAsset" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "purchaseCents" INTEGER NOT NULL,
    "salvageCents" INTEGER NOT NULL DEFAULT 0,
    "usefulLifeMonths" INTEGER NOT NULL,
    "assetAccountCode" TEXT NOT NULL DEFAULT '152405',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "disposedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FixedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionConcept" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "base" TEXT NOT NULL DEFAULT 'subtotal',
    "thresholdUvt" INTEGER NOT NULL DEFAULT 0,
    "accountCode" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetentionConcept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "debitCents" INTEGER NOT NULL DEFAULT 0,
    "creditCents" INTEGER NOT NULL DEFAULT 0,
    "memo" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpensePayment" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "accountCode" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpensePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Restaurant_slug_key" ON "Restaurant"("slug");

-- CreateIndex
CREATE INDEX "Restaurant_slug_idx" ON "Restaurant"("slug");

-- CreateIndex
CREATE INDEX "Restaurant_groupId_idx" ON "Restaurant"("groupId");

-- CreateIndex
CREATE INDEX "Restaurant_salesRepUserId_idx" ON "Restaurant"("salesRepUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Group_slug_key" ON "Group"("slug");

-- CreateIndex
CREATE INDEX "Group_slug_idx" ON "Group"("slug");

-- CreateIndex
CREATE INDEX "LegalEntity_groupId_idx" ON "LegalEntity"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanConfig_tier_key" ON "PlanConfig"("tier");

-- CreateIndex
CREATE INDEX "AuditEvent_restaurantId_occurredAt_idx" ON "AuditEvent"("restaurantId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_kind_occurredAt_idx" ON "AuditEvent"("kind", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_occurredAt_idx" ON "AuditEvent"("actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_occurredAt_idx" ON "AuditEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "MembershipPayment_restaurantId_createdAt_idx" ON "MembershipPayment"("restaurantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_restaurantId_key" ON "BillingSubscription"("restaurantId");

-- CreateIndex
CREATE INDEX "BillingSubscription_status_nextChargeAt_idx" ON "BillingSubscription"("status", "nextChargeAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionEntry_membershipPaymentId_key" ON "CommissionEntry"("membershipPaymentId");

-- CreateIndex
CREATE INDEX "CommissionEntry_salesRepUserId_createdAt_idx" ON "CommissionEntry"("salesRepUserId", "createdAt");

-- CreateIndex
CREATE INDEX "CommissionEntry_restaurantId_idx" ON "CommissionEntry"("restaurantId");

-- CreateIndex
CREATE INDEX "CommissionEntry_status_idx" ON "CommissionEntry"("status");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_restaurantId_idx" ON "User"("restaurantId");

-- CreateIndex
CREATE INDEX "User_groupId_idx" ON "User"("groupId");

-- CreateIndex
CREATE INDEX "User_managerId_idx" ON "User"("managerId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "PushSubscription_restaurantId_idx" ON "PushSubscription"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "Table_qrToken_key" ON "Table"("qrToken");

-- CreateIndex
CREATE INDEX "Table_restaurantId_idx" ON "Table"("restaurantId");

-- CreateIndex
CREATE INDEX "Table_restaurantId_waiterCalledAt_idx" ON "Table"("restaurantId", "waiterCalledAt");

-- CreateIndex
CREATE UNIQUE INDEX "Table_restaurantId_number_key" ON "Table"("restaurantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_confirmationCode_key" ON "Reservation"("confirmationCode");

-- CreateIndex
CREATE INDEX "Reservation_restaurantId_startsAt_idx" ON "Reservation"("restaurantId", "startsAt");

-- CreateIndex
CREATE INDEX "Reservation_tableId_startsAt_idx" ON "Reservation"("tableId", "startsAt");

-- CreateIndex
CREATE INDEX "Reservation_confirmationCode_idx" ON "Reservation"("confirmationCode");

-- CreateIndex
CREATE INDEX "Menu_restaurantId_idx" ON "Menu"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "Menu_restaurantId_slug_key" ON "Menu"("restaurantId", "slug");

-- CreateIndex
CREATE INDEX "Category_restaurantId_idx" ON "Category"("restaurantId");

-- CreateIndex
CREATE INDEX "Category_menuId_idx" ON "Category"("menuId");

-- CreateIndex
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_restaurantId_slug_key" ON "Category"("restaurantId", "slug");

-- CreateIndex
CREATE INDEX "MenuItem_restaurantId_categoryId_idx" ON "MenuItem"("restaurantId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shortCode_key" ON "Order"("shortCode");

-- CreateIndex
CREATE INDEX "Order_restaurantId_status_idx" ON "Order"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "Order_tableId_idx" ON "Order"("tableId");

-- CreateIndex
CREATE INDEX "Order_restaurantId_needsWaiter_idx" ON "Order"("restaurantId", "needsWaiter");

-- CreateIndex
CREATE INDEX "Round_orderId_idx" ON "Round"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Round_orderId_seq_key" ON "Round"("orderId", "seq");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_roundId_idx" ON "OrderItem"("roundId");

-- CreateIndex
CREATE UNIQUE INDEX "DishRating_orderItemId_key" ON "DishRating"("orderItemId");

-- CreateIndex
CREATE INDEX "DishRating_restaurantId_createdAt_idx" ON "DishRating"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "DishRating_menuItemId_idx" ON "DishRating"("menuItemId");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE INDEX "Payment_shiftId_idx" ON "Payment"("shiftId");

-- CreateIndex
CREATE INDEX "Payment_collectedByUserId_idx" ON "Payment"("collectedByUserId");

-- CreateIndex
CREATE INDEX "Shift_restaurantId_status_idx" ON "Shift"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "Shift_restaurantId_openedAt_idx" ON "Shift"("restaurantId", "openedAt");

-- CreateIndex
CREATE INDEX "Shift_userId_status_idx" ON "Shift"("userId", "status");

-- CreateIndex
CREATE INDEX "CashMovement_restaurantId_occurredAt_idx" ON "CashMovement"("restaurantId", "occurredAt");

-- CreateIndex
CREATE INDEX "CashMovement_shiftId_idx" ON "CashMovement"("shiftId");

-- CreateIndex
CREATE INDEX "Ingredient_restaurantId_active_idx" ON "Ingredient"("restaurantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_restaurantId_name_key" ON "Ingredient"("restaurantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_restaurantId_barcode_key" ON "Ingredient"("restaurantId", "barcode");

-- CreateIndex
CREATE INDEX "Supplier_restaurantId_active_idx" ON "Supplier"("restaurantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_restaurantId_name_key" ON "Supplier"("restaurantId", "name");

-- CreateIndex
CREATE INDEX "SupplierIngredient_ingredientId_idx" ON "SupplierIngredient"("ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierIngredient_supplierId_ingredientId_key" ON "SupplierIngredient"("supplierId", "ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLevel_ingredientId_key" ON "StockLevel"("ingredientId");

-- CreateIndex
CREATE INDEX "StockLevel_restaurantId_idx" ON "StockLevel"("restaurantId");

-- CreateIndex
CREATE INDEX "StockMovement_restaurantId_createdAt_idx" ON "StockMovement"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_ingredientId_createdAt_idx" ON "StockMovement"("ingredientId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_orderId_idx" ON "StockMovement"("orderId");

-- CreateIndex
CREATE INDEX "StockMovement_productionBatchId_idx" ON "StockMovement"("productionBatchId");

-- CreateIndex
CREATE INDEX "StockCount_restaurantId_status_idx" ON "StockCount"("restaurantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountItem_countId_ingredientId_key" ON "StockCountItem"("countId", "ingredientId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_restaurantId_status_idx" ON "PurchaseOrder"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "PurchaseOrder_restaurantId_invoiceDueAt_idx" ON "PurchaseOrder"("restaurantId", "invoiceDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_restaurantId_number_key" ON "PurchaseOrder"("restaurantId", "number");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_purchaseOrderId_idx" ON "PurchaseOrderItem"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchasePayment_purchaseOrderId_idx" ON "PurchasePayment"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchasePayment_restaurantId_paidAt_idx" ON "PurchasePayment"("restaurantId", "paidAt");

-- CreateIndex
CREATE INDEX "SupplierPriceHistory_supplierItemId_createdAt_idx" ON "SupplierPriceHistory"("supplierItemId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_menuItemId_key" ON "Recipe"("menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_outputIngredientId_key" ON "Recipe"("outputIngredientId");

-- CreateIndex
CREATE INDEX "Recipe_restaurantId_idx" ON "Recipe"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeItem_recipeId_ingredientId_key" ON "RecipeItem"("recipeId", "ingredientId");

-- CreateIndex
CREATE INDEX "ModifierRecipeItem_recipeId_idx" ON "ModifierRecipeItem"("recipeId");

-- CreateIndex
CREATE UNIQUE INDEX "ModifierRecipeItem_recipeId_modifierId_optLabel_ingredientI_key" ON "ModifierRecipeItem"("recipeId", "modifierId", "optLabel", "ingredientId");

-- CreateIndex
CREATE INDEX "ProductionBatch_restaurantId_createdAt_idx" ON "ProductionBatch"("restaurantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE INDEX "Employee_restaurantId_active_idx" ON "Employee"("restaurantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_restaurantId_name_key" ON "Employee"("restaurantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_restaurantId_month_key" ON "PayrollRun"("restaurantId", "month");

-- CreateIndex
CREATE INDEX "PayrollItem_runId_idx" ON "PayrollItem"("runId");

-- CreateIndex
CREATE INDEX "StaffShift_restaurantId_date_idx" ON "StaffShift"("restaurantId", "date");

-- CreateIndex
CREATE INDEX "StaffShift_employeeId_date_idx" ON "StaffShift"("employeeId", "date");

-- CreateIndex
CREATE INDEX "StaffShift_restaurantId_reviewNeededAt_idx" ON "StaffShift"("restaurantId", "reviewNeededAt");

-- CreateIndex
CREATE INDEX "PurchaseInvoiceUpload_restaurantId_status_idx" ON "PurchaseInvoiceUpload"("restaurantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DianConfig_legalEntityId_key" ON "DianConfig"("legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "DianConfig_restaurantId_key" ON "DianConfig"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "DianDocument_simpleInvoiceId_key" ON "DianDocument"("simpleInvoiceId");

-- CreateIndex
CREATE INDEX "DianDocument_restaurantId_state_idx" ON "DianDocument"("restaurantId", "state");

-- CreateIndex
CREATE INDEX "Expense_restaurantId_date_idx" ON "Expense"("restaurantId", "date");

-- CreateIndex
CREATE INDEX "Expense_restaurantId_recurring_idx" ON "Expense"("restaurantId", "recurring");

-- CreateIndex
CREATE INDEX "KushkiDocument_restaurantId_kind_idx" ON "KushkiDocument"("restaurantId", "kind");

-- CreateIndex
CREATE INDEX "KushkiDocument_sftpUploadedAt_idx" ON "KushkiDocument"("sftpUploadedAt");

-- CreateIndex
CREATE UNIQUE INDEX "KushkiTransaction_kushkiTxId_key" ON "KushkiTransaction"("kushkiTxId");

-- CreateIndex
CREATE INDEX "KushkiTransaction_restaurantId_createdAt_idx" ON "KushkiTransaction"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletMovement_restaurantId_occurredAt_idx" ON "WalletMovement"("restaurantId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletMovement_restaurantId_kushkiRef_key" ON "WalletMovement"("restaurantId", "kushkiRef");

-- CreateIndex
CREATE INDEX "Payout_restaurantId_createdAt_idx" ON "Payout"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "Payout_providerRef_idx" ON "Payout"("providerRef");

-- CreateIndex
CREATE INDEX "Payout_ticketNumber_idx" ON "Payout"("ticketNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TerminalDevice_kushkiDeviceId_key" ON "TerminalDevice"("kushkiDeviceId");

-- CreateIndex
CREATE INDEX "TerminalDevice_restaurantId_active_idx" ON "TerminalDevice"("restaurantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "KushkiWebhookEvent_eventId_key" ON "KushkiWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "KushkiWebhookEvent_type_createdAt_idx" ON "KushkiWebhookEvent"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SimpleInvoice_orderId_key" ON "SimpleInvoice"("orderId");

-- CreateIndex
CREATE INDEX "SimpleInvoice_restaurantId_createdAt_idx" ON "SimpleInvoice"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "InvoiceRequest_restaurantId_status_createdAt_idx" ON "InvoiceRequest"("restaurantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "InvoiceRequest_orderId_idx" ON "InvoiceRequest"("orderId");

-- CreateIndex
CREATE INDEX "Translation_entityType_entityId_idx" ON "Translation"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Translation_entityType_entityId_field_locale_key" ON "Translation"("entityType", "entityId", "field", "locale");

-- CreateIndex
CREATE INDEX "AiConversation_restaurantId_userId_idx" ON "AiConversation"("restaurantId", "userId");

-- CreateIndex
CREATE INDEX "AiConversation_groupId_userId_idx" ON "AiConversation"("groupId", "userId");

-- CreateIndex
CREATE INDEX "AiMessage_conversationId_createdAt_idx" ON "AiMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "SearchEvent_restaurantId_createdAt_idx" ON "SearchEvent"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "SearchEvent_restaurantId_term_idx" ON "SearchEvent"("restaurantId", "term");

-- CreateIndex
CREATE INDEX "CrmLead_assignedToUserId_stage_idx" ON "CrmLead"("assignedToUserId", "stage");

-- CreateIndex
CREATE INDEX "CrmLead_assignedToUserId_nextActionAt_idx" ON "CrmLead"("assignedToUserId", "nextActionAt");

-- CreateIndex
CREATE INDEX "CrmLead_countryCode_idx" ON "CrmLead"("countryCode");

-- CreateIndex
CREATE INDEX "CrmContact_leadId_idx" ON "CrmContact"("leadId");

-- CreateIndex
CREATE INDEX "CrmActivity_leadId_createdAt_idx" ON "CrmActivity"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmAppointment_userId_startsAt_idx" ON "CrmAppointment"("userId", "startsAt");

-- CreateIndex
CREATE INDEX "CrmAppointment_leadId_idx" ON "CrmAppointment"("leadId");

-- CreateIndex
CREATE INDEX "CrmDocument_ownerUserId_idx" ON "CrmDocument"("ownerUserId");

-- CreateIndex
CREATE INDEX "CrmEmailTemplate_ownerUserId_idx" ON "CrmEmailTemplate"("ownerUserId");

-- CreateIndex
CREATE INDEX "CrmWhatsappTemplate_ownerUserId_idx" ON "CrmWhatsappTemplate"("ownerUserId");

-- CreateIndex
CREATE INDEX "CrmEmailAccount_userId_idx" ON "CrmEmailAccount"("userId");

-- CreateIndex
CREATE INDEX "CrmCity_countryCode_name_idx" ON "CrmCity"("countryCode", "name");

-- CreateIndex
CREATE UNIQUE INDEX "CrmCity_countryCode_name_key" ON "CrmCity"("countryCode", "name");

-- CreateIndex
CREATE INDEX "LedgerAccount_restaurantId_code_idx" ON "LedgerAccount"("restaurantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_restaurantId_code_key" ON "LedgerAccount"("restaurantId", "code");

-- CreateIndex
CREATE INDEX "JournalEntry_restaurantId_date_idx" ON "JournalEntry"("restaurantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_restaurantId_source_sourceRef_key" ON "JournalEntry"("restaurantId", "source", "sourceRef");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingConfig_restaurantId_key" ON "AccountingConfig"("restaurantId");

-- CreateIndex
CREATE INDEX "TaxFiling_restaurantId_period_idx" ON "TaxFiling"("restaurantId", "period");

-- CreateIndex
CREATE INDEX "CostCenter_restaurantId_idx" ON "CostCenter"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_restaurantId_year_accountCode_key" ON "Budget"("restaurantId", "year", "accountCode");

-- CreateIndex
CREATE INDEX "BankStatementLine_restaurantId_status_idx" ON "BankStatementLine"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "BankStatementLine_restaurantId_date_idx" ON "BankStatementLine"("restaurantId", "date");

-- CreateIndex
CREATE INDEX "BankRecRule_restaurantId_idx" ON "BankRecRule"("restaurantId");

-- CreateIndex
CREATE INDEX "FixedAsset_restaurantId_idx" ON "FixedAsset"("restaurantId");

-- CreateIndex
CREATE INDEX "RetentionConcept_restaurantId_idx" ON "RetentionConcept"("restaurantId");

-- CreateIndex
CREATE INDEX "JournalLine_entryId_idx" ON "JournalLine"("entryId");

-- CreateIndex
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");

-- CreateIndex
CREATE INDEX "ExpensePayment_expenseId_idx" ON "ExpensePayment"("expenseId");

-- CreateIndex
CREATE INDEX "ExpensePayment_restaurantId_paidAt_idx" ON "ExpensePayment"("restaurantId", "paidAt");

-- AddForeignKey
ALTER TABLE "Restaurant" ADD CONSTRAINT "Restaurant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Restaurant" ADD CONSTRAINT "Restaurant_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Restaurant" ADD CONSTRAINT "Restaurant_salesRepUserId_fkey" FOREIGN KEY ("salesRepUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalEntity" ADD CONSTRAINT "LegalEntity_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipPayment" ADD CONSTRAINT "MembershipPayment_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_salesRepUserId_fkey" FOREIGN KEY ("salesRepUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_membershipPaymentId_fkey" FOREIGN KEY ("membershipPaymentId") REFERENCES "MembershipPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Table" ADD CONSTRAINT "Table_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Menu" ADD CONSTRAINT "Menu_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "Menu"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Round" ADD CONSTRAINT "Round_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishRating" ADD CONSTRAINT "DishRating_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishRating" ADD CONSTRAINT "DishRating_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishRating" ADD CONSTRAINT "DishRating_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DishRating" ADD CONSTRAINT "DishRating_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_collectedByUserId_fkey" FOREIGN KEY ("collectedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierIngredient" ADD CONSTRAINT "SupplierIngredient_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierIngredient" ADD CONSTRAINT "SupplierIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_stockCountId_fkey" FOREIGN KEY ("stockCountId") REFERENCES "StockCount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_productionBatchId_fkey" FOREIGN KEY ("productionBatchId") REFERENCES "ProductionBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountItem" ADD CONSTRAINT "StockCountItem_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountItem" ADD CONSTRAINT "StockCountItem_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_supplierItemId_fkey" FOREIGN KEY ("supplierItemId") REFERENCES "SupplierIngredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPriceHistory" ADD CONSTRAINT "SupplierPriceHistory_supplierItemId_fkey" FOREIGN KEY ("supplierItemId") REFERENCES "SupplierIngredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPriceHistory" ADD CONSTRAINT "SupplierPriceHistory_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_outputIngredientId_fkey" FOREIGN KEY ("outputIngredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeItem" ADD CONSTRAINT "RecipeItem_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeItem" ADD CONSTRAINT "RecipeItem_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModifierRecipeItem" ADD CONSTRAINT "ModifierRecipeItem_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModifierRecipeItem" ADD CONSTRAINT "ModifierRecipeItem_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionBatch" ADD CONSTRAINT "ProductionBatch_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionBatch" ADD CONSTRAINT "ProductionBatch_outputIngredientId_fkey" FOREIGN KEY ("outputIngredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionBatch" ADD CONSTRAINT "ProductionBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffShift" ADD CONSTRAINT "StaffShift_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffShift" ADD CONSTRAINT "StaffShift_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseInvoiceUpload" ADD CONSTRAINT "PurchaseInvoiceUpload_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseInvoiceUpload" ADD CONSTRAINT "PurchaseInvoiceUpload_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseInvoiceUpload" ADD CONSTRAINT "PurchaseInvoiceUpload_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DianConfig" ADD CONSTRAINT "DianConfig_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DianConfig" ADD CONSTRAINT "DianConfig_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DianDocument" ADD CONSTRAINT "DianDocument_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DianDocument" ADD CONSTRAINT "DianDocument_simpleInvoiceId_fkey" FOREIGN KEY ("simpleInvoiceId") REFERENCES "SimpleInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KushkiDocument" ADD CONSTRAINT "KushkiDocument_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KushkiDocument" ADD CONSTRAINT "KushkiDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KushkiTransaction" ADD CONSTRAINT "KushkiTransaction_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KushkiTransaction" ADD CONSTRAINT "KushkiTransaction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletMovement" ADD CONSTRAINT "WalletMovement_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminalDevice" ADD CONSTRAINT "TerminalDevice_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminalDevice" ADD CONSTRAINT "TerminalDevice_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KushkiWebhookEvent" ADD CONSTRAINT "KushkiWebhookEvent_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimpleInvoice" ADD CONSTRAINT "SimpleInvoice_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimpleInvoice" ADD CONSTRAINT "SimpleInvoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMessage" ADD CONSTRAINT "AiMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchEvent" ADD CONSTRAINT "SearchEvent_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmLead" ADD CONSTRAINT "CrmLead_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "CrmCity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmLead" ADD CONSTRAINT "CrmLead_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmLead" ADD CONSTRAINT "CrmLead_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmLead" ADD CONSTRAINT "CrmLead_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmContact" ADD CONSTRAINT "CrmContact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "CrmLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "CrmLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmAppointment" ADD CONSTRAINT "CrmAppointment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "CrmLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmAppointment" ADD CONSTRAINT "CrmAppointment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDocument" ADD CONSTRAINT "CrmDocument_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmEmailTemplate" ADD CONSTRAINT "CrmEmailTemplate_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmWhatsappTemplate" ADD CONSTRAINT "CrmWhatsappTemplate_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmEmailAccount" ADD CONSTRAINT "CrmEmailAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmCity" ADD CONSTRAINT "CrmCity_countryCode_fkey" FOREIGN KEY ("countryCode") REFERENCES "CrmCountry"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingConfig" ADD CONSTRAINT "AccountingConfig_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxFiling" ADD CONSTRAINT "TaxFiling_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankRecRule" ADD CONSTRAINT "BankRecRule_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetentionConcept" ADD CONSTRAINT "RetentionConcept_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpensePayment" ADD CONSTRAINT "ExpensePayment_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpensePayment" ADD CONSTRAINT "ExpensePayment_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpensePayment" ADD CONSTRAINT "ExpensePayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

