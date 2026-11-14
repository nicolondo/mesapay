// Vista del documento soporte para la pantalla (sin XML ni secretos) y los
// datos del panel de un gasto o una compra.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { municipioLabel, findMunicipioByCode } from "@/lib/dane/municipios";
import { findDianCountry } from "./catalogs";
import { supportDocConfigView, type SupportDocConfigView } from "./config";
import { VOID_REASON } from "./constants";
import { missingSellerFields, SUPPLIER_DS_SELECT, type SellerMissing } from "./seller";
import { activeKeyFor, lastTransmissionDate } from "./source";
import type { SupportDocSnapshot, SupportDocSourceType, UntransmittedWithholding } from "./types";

export type SupportDocView = {
  id: string;
  kind: "support_document" | "adjustment_note";
  documentNumber: string;
  /** "1" producción · "2" pruebas (sin validez fiscal). */
  environment: "1" | "2";
  state: string;
  cuds: string | null;
  issuedAt: string | null;
  createdAt: string;
  errors: string[];
  lastError: string | null;
  subtotalCents: number;
  taxCents: number;
  withholdingCents: number;
  totalCents: number;
  reasonCode: string | null;
  reasonText: string | null;
  adjustsId: string | null;
  /** DS anulado por una nota de ajuste aceptada. */
  voided: boolean;
  /** Base que todavía se puede ajustar (DS aceptado). */
  adjustableCents: number;
  canResend: boolean;
  canCheckStatus: boolean;
  canAdjust: boolean;
  hasXml: boolean;
  untransmitted: UntransmittedWithholding[];
};

type Row = Prisma.SupportDocumentGetPayload<{
  select: typeof VIEW_SELECT;
}>;

const VIEW_SELECT = {
  id: true,
  kind: true,
  documentNumber: true,
  environment: true,
  state: true,
  cuds: true,
  issuedAt: true,
  createdAt: true,
  errors: true,
  lastError: true,
  subtotalCents: true,
  taxCents: true,
  withholdingCents: true,
  totalCents: true,
  reasonCode: true,
  reasonText: true,
  adjustsId: true,
  snapshot: true,
  xmlZip: false,
  submissionFileName: true,
} as const;

function toView(row: Row, all: Row[]): SupportDocView {
  const notes = all.filter((n) => n.adjustsId === row.id && n.state !== "rejected");
  const voided = notes.some((n) => n.reasonCode === VOID_REASON && n.state === "accepted");
  const adjusted = notes.reduce((a, n) => a + n.subtotalCents, 0);
  const adjustableCents =
    row.kind === "support_document" && row.state === "accepted" && !notes.some((n) => n.reasonCode === VOID_REASON)
      ? Math.max(0, row.subtotalCents - adjusted)
      : 0;
  const snap = row.snapshot as unknown as SupportDocSnapshot;
  return {
    id: row.id,
    kind: row.kind as SupportDocView["kind"],
    documentNumber: row.documentNumber,
    environment: row.environment as "1" | "2",
    state: row.state,
    cuds: row.cuds,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    errors: Array.isArray(row.errors) ? row.errors.map(String) : [],
    lastError: row.lastError,
    subtotalCents: row.subtotalCents,
    taxCents: row.taxCents,
    withholdingCents: row.withholdingCents,
    totalCents: row.totalCents,
    reasonCode: row.reasonCode,
    reasonText: row.reasonText,
    adjustsId: row.adjustsId,
    voided,
    adjustableCents,
    canResend: ["to_send", "error", "rejected"].includes(row.state),
    canCheckStatus: ["pending", "error"].includes(row.state) && !!row.cuds,
    canAdjust: adjustableCents > 0,
    hasXml: !!row.submissionFileName,
    untransmitted: snap?.untransmittedWithholdings ?? [],
  };
}

export type SupportDocSupplierView = {
  id: string;
  name: string;
  taxId: string | null;
  taxIdType: string | null;
  personType: string | null;
  address: string | null;
  notObligatedToInvoice: boolean;
  cityCode: string | null;
  cityLabel: string | null;
  postalCode: string | null;
  countryCode: string | null;
  countryName: string | null;
  foreignCityName: string | null;
  missing: SellerMissing[];
};

export type SupportDocPanel = {
  config: SupportDocConfigView;
  supplier: SupportDocSupplierView | null;
  /** Documento soporte vigente (o el último) + sus notas de ajuste. */
  documents: SupportDocView[];
  /** ¿Ya hay un documento soporte vigente para este gasto o compra? */
  hasActive: boolean;
  /** Fecha de la operación y último día para transmitirla (Colombia). */
  operationDate: string | null;
  deadline: string | null;
  /** La compra todavía no está recibida completa / el gasto es plantilla. */
  sourceReady: boolean;
};

export function supplierView(s: Prisma.SupplierGetPayload<{ select: typeof SUPPLIER_DS_SELECT }>): SupportDocSupplierView {
  const m = findMunicipioByCode(s.cityCode);
  const country = findDianCountry(s.countryCode);
  return {
    id: s.id,
    name: s.name,
    taxId: s.taxId,
    taxIdType: s.taxIdType,
    personType: s.personType,
    address: s.address,
    notObligatedToInvoice: s.notObligatedToInvoice,
    cityCode: s.cityCode,
    cityLabel: m ? municipioLabel(m) : null,
    postalCode: s.postalCode,
    countryCode: s.countryCode,
    countryName: country?.name ?? null,
    foreignCityName: s.foreignCityName,
    missing: missingSellerFields(s),
  };
}

/** Todo lo que el panel de un gasto o una compra necesita. */
export async function supportDocPanel(
  restaurantId: string,
  sourceType: SupportDocSourceType,
  sourceId: string,
): Promise<SupportDocPanel | null> {
  const { dianIssueDateTime } = await import("@/lib/dian/dianDateTime");
  let supplier: Prisma.SupplierGetPayload<{ select: typeof SUPPLIER_DS_SELECT }> | null = null;
  let operationAt: Date | null = null;
  let sourceReady = true;
  if (sourceType === "expense") {
    const e = await db.expense.findFirst({
      where: { id: sourceId, restaurantId },
      select: { date: true, recurring: true, supplier: { select: SUPPLIER_DS_SELECT } },
    });
    if (!e) return null;
    supplier = e.supplier;
    operationAt = e.date;
    sourceReady = !e.recurring;
  } else {
    const p = await db.purchaseOrder.findFirst({
      where: { id: sourceId, restaurantId },
      select: { status: true, receivedAt: true, createdAt: true, supplier: { select: SUPPLIER_DS_SELECT } },
    });
    if (!p) return null;
    supplier = p.supplier;
    operationAt = p.receivedAt ?? (p.status === "received" ? p.createdAt : null);
    sourceReady = p.status === "received";
  }
  const where =
    sourceType === "expense" ? { restaurantId, expenseId: sourceId } : { restaurantId, purchaseOrderId: sourceId };
  const [config, rows] = await Promise.all([
    supportDocConfigView(restaurantId),
    db.supportDocument.findMany({ where, orderBy: { createdAt: "asc" }, select: VIEW_SELECT }),
  ]);
  const activeKey = activeKeyFor(sourceType, sourceId);
  const active = await db.supportDocument.findUnique({ where: { activeKey }, select: { id: true } });
  const operationDate = operationAt ? dianIssueDateTime(operationAt).date : null;
  return {
    config,
    supplier: supplier ? supplierView(supplier) : null,
    documents: rows.map((r) => toView(r, rows)),
    hasActive: !!active,
    operationDate,
    deadline: operationDate ? lastTransmissionDate(operationDate) : null,
    sourceReady,
  };
}

/** Un documento con su snapshot completo (representación gráfica). */
export async function loadSupportDocForPrint(restaurantId: string, id: string) {
  const row = await db.supportDocument.findFirst({
    where: { id, restaurantId },
    select: {
      ...VIEW_SELECT,
      adjusts: { select: { documentNumber: true } },
    },
  });
  if (!row) return null;
  const siblings = await db.supportDocument.findMany({
    where: { restaurantId, OR: [{ id: row.id }, { adjustsId: row.id }] },
    select: VIEW_SELECT,
  });
  return {
    view: toView(row, siblings),
    snapshot: row.snapshot as unknown as SupportDocSnapshot,
    adjustsNumber: row.adjusts?.documentNumber ?? null,
  };
}
