"use client";

// Crear/editar un gasto (sheet). Lo simple sigue siendo simple —categoría,
// valor y guardar— y lo fiscal vive en dos secciones que se abren:
// «Documento soporte» (tipo, número, fecha, foto/PDF y «Leer con IA») e
// «Impuestos y retenciones» (descuento, IVA, INC, retenciones sugeridas con
// los conceptos del comercio y el resumen Total a pagar / Costo del gasto).
// Los cálculos son los MISMOS que hace el servidor al guardar
// (`@/lib/erp/expenseTax`): lo que se ve es lo que se asienta.
//
// El proveedor se elige o se crea ahí mismo («+ Nuevo proveedor»): una hoja
// encima del gasto, sin perder lo que ya se escribió.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney, formatNumber, pesosToCents } from "@/lib/format";
import { conceptRateBps } from "@/lib/erp/retencionesCore";
import { expenseOutstandingCents } from "@/lib/erp/accounting";
import {
  EXPENSE_DOCUMENT_TYPES,
  expenseAmounts,
  expenseHasTaxes,
  expenseTaxesImplied,
  retentionAmountCents,
  retentionBaseCents,
  suggestExpenseRetentions,
  uvtCentsForDate,
  type ExpenseDocumentType,
} from "@/lib/erp/expenseTax";
import {
  SUPPLIER_TAX_ID_TYPES,
  defaultPersonType,
  normalizeSupplierTaxId,
  type SupplierPersonType,
  type SupplierTaxIdType,
} from "@/lib/erp/supplierTaxId";
import { MoneyInput } from "@/components/MoneyInput";
import { formatExpenseNumber } from "@/lib/erp/expenseNumberFormat";
import { parseDuplicateConflict, type DuplicateConflict } from "@/lib/erp/documentNumber";
import { DuplicateDocumentAlert, useDuplicateDocumentCheck } from "@/components/suppliers/DuplicateDocumentAlert";
import { SupplierCombobox } from "@/components/suppliers/SupplierCombobox";
import { AccountCombobox } from "@/components/accounts/AccountCombobox";
import { SupportDocumentPanel } from "@/components/supportDocument/SupportDocumentPanel";

/* ───────────────────────────── Tipos ───────────────────────────────── */
// Espejo de GET /api/operator/expenses, /suppliers y /expenses/tax-context.

export type ChartAccountRef = {
  code: string;
  name: string;
  type: string;
  postable: boolean;
};

export type SupplierRef = { id: string; name: string; taxId?: string | null };

export type ExpenseRetentionDto = {
  id: string;
  conceptId: string | null;
  kind: string;
  name: string;
  rateBps: number;
  /** Tarifa exacta en ppm (null = la de `rateBps`, gastos anteriores). */
  ratePpm?: number | null;
  base: string;
  accountCode: string;
  baseCents: number;
  amountCents: number;
};

export type ExpenseDto = {
  id: string;
  /** Consecutivo interno (G-0012). null: plantilla, o recién creado por una versión anterior. */
  number?: number | null;
  category: string;
  description: string | null;
  /** Costo del gasto (PYG): base + INC + IVA no descontable. */
  amountCents: number;
  /** ISO — fecha contable del gasto (editable, no createdAt). */
  date: string;
  supplierId: string | null;
  supplier: SupplierRef | null;
  costCenterId: string | null;
  accountCode?: string | null;
  dueAt?: string | null;
  paidCents?: number;
  paidAt?: string | null;
  costCenter: { id: string; name: string } | null;
  recurring: boolean;
  /** 1-28 solo en plantillas (recurring: true). */
  recurringDay: number | null;
  templateId: string | null;
  documentType?: string;
  documentNumber?: string | null;
  documentDate?: string | null;
  attachmentUrl?: string | null;
  baseCents?: number;
  discountCents?: number;
  ivaPct?: number;
  ivaCents?: number;
  ivaDeductible?: boolean;
  incCents?: number;
  retefuenteCents?: number;
  reteIvaCents?: number;
  reteIcaCents?: number;
  /** Total a pagar (0 en gastos anteriores = su valor). */
  payableCents?: number;
  retentions?: ExpenseRetentionDto[];
};

type ConceptDto = {
  id: string;
  kind: string;
  name: string;
  /** Tarifa efectiva en bps (puede tener decimales: 4,14 ‰ = 41,4). */
  rateBps: number;
  base: string;
  thresholdUvt: number;
  accountCode: string;
  active: boolean;
  catalogKey?: string | null;
};

type TaxContext = {
  concepts: ConceptDto[];
  uvtCents: number;
  ivaDeductible: boolean;
  ivaRates: number[];
};

/** Retención en el formulario. `amount` null = la calcula la tarifa (sigue a la base). */
type RetLine = {
  conceptId: string | null;
  sourceId?: string;
  kind: string;
  name: string;
  rateBps: number;
  base: string;
  amount: number | null;
};

type Prefill = {
  documentType: ExpenseDocumentType | null;
  documentNumber: string | null;
  documentDate: string | null;
  supplierName: string | null;
  supplierTaxId: string | null;
  supplierId: string | null;
  subtotalCents: number | null;
  discountCents: number | null;
  ivaPct: number | null;
  ivaCents: number | null;
  incCents: number | null;
  totalCents: number | null;
};

/* ─────────────────────────── Utilidades ────────────────────────────── */

/** "2026-07-10" (input date) → ISO al mediodía local (sin corrimiento de día). */
export function dateInputToIso(value: string): string {
  return new Date(`${value}T12:00:00`).toISOString();
}

export function isoToDateInput(value: string): string {
  const d = new Date(value);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Hoy en formato input date — default del formulario de gasto. */
export function todayDateInput(): string {
  return isoToDateInput(new Date().toISOString());
}

/** "125000.5" (MoneyInput) → centavos; 0 si vacío o inválido. */
function rawToCents(raw: string): number {
  const pesos = Number(raw.replace(",", "."));
  return raw.trim() !== "" && Number.isFinite(pesos) && pesos > 0 ? pesosToCents(pesos) : 0;
}

/** "901.944.469-1", "1020304050": un documento, no un nombre. */
function looksLikeTaxId(text: string): boolean {
  return /^[\d.\s-]{5,}$/.test(text.trim());
}

const centsToRaw = (cents: number | null | undefined) => (cents != null && cents > 0 ? String(cents / 100) : "");

// Errores del POST/PATCH/DELETE de gastos → clave i18n (fallback
// errSaveFailed). recurring_day_forbidden es defensivo: el formulario
// nunca manda día sin recurrente.
export const API_ERROR_KEYS: Record<string, string> = {
  invalid: "errExpenseInvalid",
  recurring_day_required: "errRecurringDayRequired",
  recurring_day_forbidden: "errRecurringDayForbidden",
  supplier_not_found: "errSupplierNotFound",
  not_found: "errExpenseNotFound",
  exceeds_balance: "errExpensePayExceeds",
  account_not_found: "errExpensePayAccount",
  wrong_status: "errExpenseInvalid",
  supplier_required: "errExpenseSupplierRequired",
  retention_exceeds_base: "errExpenseRetentionExceeds",
  payable_not_positive: "errExpensePayableNotPositive",
  retention_not_found: "errExpenseRetentionNotFound",
  below_paid: "errExpenseBelowPaid",
};

/** Tarifa en bps → "2,5" (separador del idioma; reteICA 41,4 bps → "0,414"). */
function fmtRate(bps: number, locale: Locale): string {
  return formatNumber(bps / 100, { locale, maximumFractionDigits: 4 });
}

/* ──────────────── Crear/editar gasto (sheet) ───────────────────────── */

export function ExpenseSheet({
  expense,
  currency,
  suppliers,
  categories,
  onClose,
  onChanged,
  onSupplierCreated,
}: {
  /** null = crear. */
  expense: ExpenseDto | null;
  currency: string;
  suppliers: SupplierRef[];
  categories: string[];
  onClose: () => void;
  onChanged: () => void;
  /** Un proveedor creado inline sube al padre para persistir en la lista. */
  onSupplierCreated?: (s: SupplierRef) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const money = (c: number) => formatMoney(c, { currency, locale, fractionDigits: "auto" });

  // Proveedores creados inline en esta sesión del sheet: se muestran en el
  // select de inmediato (el prop `suppliers` solo se refresca en el padre).
  const [localSuppliers, setLocalSuppliers] = useState<SupplierRef[]>([]);
  // Alta rápida de proveedor: null = cerrada; string = abierta con ese
  // nombre (lo que se escribió en el campo, o lo que leyó la IA).
  const [createSupplierText, setCreateSupplierText] = useState<string | null>(null);

  const [category, setCategory] = useState(expense?.category ?? "");
  const [description, setDescription] = useState(expense?.description ?? "");
  // Valor ANTES de descuento e impuestos, en pesos (el API habla centavos).
  const initialSubtotal = expense
    ? (expense.baseCents && expense.baseCents > 0 ? expense.baseCents : expense.amountCents) + (expense.discountCents ?? 0)
    : 0;
  const [amountRaw, setAmountRaw] = useState(centsToRaw(initialSubtotal));
  const [date, setDate] = useState(
    expense ? isoToDateInput(expense.date) : todayDateInput(),
  );
  const [supplierId, setSupplierId] = useState(expense?.supplierId ?? "");
  // Centros de costos (opcional): se cargan perezoso al abrir el sheet.
  const [costCenterId, setCostCenterId] = useState(expense?.costCenterId ?? "");
  const [centers, setCenters] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    let alive = true;
    fetch("/api/operator/accounting/centros")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (alive)
          setCenters(
            (j.centers as Array<{ id: string; name: string; active: boolean }>)
              .filter((c) => c.active)
              .map((c) => ({ id: c.id, name: c.name })),
          );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const [accountCode, setAccountCode] = useState(expense?.accountCode ?? "");
  const [dueDate, setDueDate] = useState(expense?.dueAt ? isoToDateInput(expense.dueAt) : "");
  // Al crear, lo normal es que ya se pagó. Al editar no se toca el pago:
  // los abonos se registran aparte.
  const [paidNow, setPaidNow] = useState(true);
  const [payAccountCode, setPayAccountCode] = useState("");
  const [accounts, setAccounts] = useState<ChartAccountRef[]>([]);
  // Mientras el plan de cuentas carga no se sabe la caja del pago de
  // contado: guardar en ese instante dejaba el gasto «por pagar» sin aviso.
  const [accountsLoading, setAccountsLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    fetch("/api/operator/accounting/chart")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (!alive) return;
        const rows = (j.accounts as ChartAccountRef[]).filter((a) => a.postable);
        setAccounts(rows);
        // Default del pago: la primera cuenta de caja/bancos del plan.
        setPayAccountCode((prev) => prev || (rows.find((a) => a.code.startsWith("11"))?.code ?? ""));
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setAccountsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // ── Impuestos: contexto del comercio (conceptos, UVT, IVA descontable) ──
  const [taxCtx, setTaxCtx] = useState<TaxContext | null>(null);
  const [taxLoadError, setTaxLoadError] = useState(false);
  const [taxLoadAttempt, setTaxLoadAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    fetch("/api/operator/expenses/tax-context", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j: TaxContext) => {
        if (alive) setTaxCtx(j);
      })
      .catch(() => {
        if (alive) setTaxLoadError(true);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      alive = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [taxLoadAttempt]);

  function retryTaxContext() {
    setTaxLoadError(false);
    setTaxLoadAttempt((attempt) => attempt + 1);
  }

  const hadTaxes = Boolean(
    expense &&
      expenseHasTaxes({
        ivaCents: expense.ivaCents ?? 0,
        incCents: expense.incCents ?? 0,
        discountCents: expense.discountCents ?? 0,
        retentionsCents: (expense.retentions ?? []).reduce((s, r) => s + r.amountCents, 0),
      }),
  );
  // `taxMode`: el gasto lleva impuestos (se abrió la sección al menos una
  // vez). Sin eso, el gasto es un valor plano —como siempre— aunque el
  // comercio tenga conceptos de retención activos.
  const [taxMode, setTaxMode] = useState(hadTaxes);
  const [taxOpen, setTaxOpen] = useState(hadTaxes);
  const [docOpen, setDocOpen] = useState(
    Boolean(expense && ((expense.documentType && expense.documentType !== "none") || expense.attachmentUrl)),
  );
  const [documentType, setDocumentType] = useState<ExpenseDocumentType>(
    (EXPENSE_DOCUMENT_TYPES as readonly string[]).includes(expense?.documentType ?? "")
      ? (expense!.documentType as ExpenseDocumentType)
      : "none",
  );
  const [documentNumber, setDocumentNumber] = useState(expense?.documentNumber ?? "");
  const [documentDate, setDocumentDate] = useState(expense?.documentDate ? isoToDateInput(expense.documentDate) : "");
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(expense?.attachmentUrl ?? null);
  const [discountRaw, setDiscountRaw] = useState(centsToRaw(expense?.discountCents));
  const [ivaPct, setIvaPct] = useState<number>(expense?.ivaPct ?? 0);
  // IVA impreso (manda sobre la tarifa). Al editar se carga el guardado.
  const [ivaPrintedRaw, setIvaPrintedRaw] = useState(
    expense && (expense.ivaCents ?? 0) > 0 ? centsToRaw(expense.ivaCents) : "",
  );
  const [incRaw, setIncRaw] = useState(centsToRaw(expense?.incCents));
  // null = retenciones SUGERIDAS (siguen a la base); lista = las que dejó el operador.
  const [retLines, setRetLines] = useState<RetLine[] | null>(
    expense && (expense.retentions?.length ?? 0) > 0
      ? expense.retentions!.map((r) => ({
          conceptId: r.conceptId,
          sourceId: r.conceptId ? undefined : r.id,
          kind: r.kind,
          name: r.name,
          rateBps: conceptRateBps(r),
          base: r.base,
          amount: r.amountCents,
        }))
      : expense && hadTaxes
        ? []
        : null,
  );

  const [recurring, setRecurring] = useState(expense?.recurring ?? false);
  const [dayRaw, setDayRaw] = useState(
    expense?.recurringDay != null ? String(expense.recurringDay) : "",
  );
  const [busy, setBusy] = useState(false);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Documento del proveedor repetido (409 del servidor, en compras o gastos).
  const [dup, setDup] = useState<DuplicateConflict | null>(null);
  const [aiNote, setAiNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [prefillName, setPrefillName] = useState<{ name: string; taxId: string | null } | null>(null);

  // El gasto puede referenciar un proveedor que ya no está en el catálogo:
  // se agrega como opción para no perder la referencia al editar. Los
  // creados inline se anteponen.
  const supplierOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: SupplierRef[] = [];
    const push = (s: SupplierRef) => {
      if (seen.has(s.id)) return;
      seen.add(s.id);
      out.push(s);
    };
    localSuppliers.forEach(push);
    if (expense?.supplier) push(expense.supplier);
    suppliers.forEach(push);
    return out;
  }, [expense, suppliers, localSuppliers]);

  /** Abre «Impuestos y retenciones» cuando el documento o el proveedor lo sugieren. */
  function openTaxesIfImplied(next: { documentType?: string; supplierTaxId?: string | null }) {
    if (taxMode) return;
    if (expenseTaxesImplied(next)) {
      setTaxMode(true);
      setTaxOpen(true);
    }
  }

  function selectSupplier(id: string) {
    setSupplierId(id);
    const s = supplierOptions.find((x) => x.id === id);
    if (s) openTaxesIfImplied({ supplierTaxId: s.taxId ?? null });
  }

  // Proveedor creado inline (o el existente que se eligió al detectar el
  // duplicado): queda elegido, visible en el select y sube al padre.
  function handleSupplierCreated(s: SupplierRef) {
    setLocalSuppliers((prev) => [s, ...prev.filter((p) => p.id !== s.id)]);
    setSupplierId(s.id);
    setCreateSupplierText(null);
    setPrefillName(null);
    onSupplierCreated?.(s);
    openTaxesIfImplied({ supplierTaxId: s.taxId ?? null });
  }

  // ── Cálculo en vivo (el mismo del servidor) ──
  const ivaDeductible = expense && (expense.ivaCents ?? 0) > 0 ? Boolean(expense.ivaDeductible) : (taxCtx?.ivaDeductible ?? false);
  const subtotalCents = rawToCents(amountRaw);
  const printedIva = ivaPrintedRaw.trim() === "" ? null : rawToCents(ivaPrintedRaw);
  const taxInput = {
    subtotalCents,
    discountCents: taxMode ? rawToCents(discountRaw) : 0,
    ivaPct: taxMode ? ivaPct : 0,
    ivaCents: taxMode ? printedIva : null,
    ivaDeductible,
    incCents: taxMode ? rawToCents(incRaw) : 0,
  };
  const pre = expenseAmounts({ ...taxInput, retentions: [] });
  // La selección explícita usa todo el catálogo. «Activo» controla las
  // sugerencias automáticas; agregar una línea no cambia esa configuración.
  const concepts = taxCtx?.concepts ?? [];
  const activeConcepts = concepts.filter((c) => c.active);
  const uvtCents = taxCtx ? uvtCentsForDate(date || todayDateInput(), taxCtx.uvtCents) : 0;
  // Sugeridas en vivo (siguen a la base, la categoría y la cuenta) mientras
  // el operador no toque la lista.
  const suggested: RetLine[] =
    taxMode && taxCtx
      ? suggestExpenseRetentions(
          activeConcepts,
          { baseCents: pre.baseCents, ivaCents: pre.ivaCents, category, accountCode: accountCode || null },
          uvtCents,
        ).map((s) => ({ conceptId: s.conceptId, kind: s.kind, name: s.name, rateBps: s.rateBps, base: s.base, amount: null }))
      : [];
  const lines = taxMode ? (retLines ?? suggested) : [];
  const lineAmount = (l: RetLine) => l.amount ?? retentionAmountCents(l.rateBps, retentionBaseCents(l, pre));
  const amounts = expenseAmounts({
    ...taxInput,
    retentions: lines.map((l) => ({ kind: l.kind, amountCents: lineAmount(l) })),
  });

  function editLines(fn: (cur: RetLine[]) => RetLine[]) {
    setRetLines((prev) => fn(prev ?? suggested));
  }
  const addable = concepts.filter((c) => !lines.some((l) => l.conceptId === c.id));
  const inactiveRecurringNames = recurring
    ? lines.filter((l) => concepts.some((c) => c.id === l.conceptId && !c.active)).map((l) => l.name)
    : [];

  // ── Soporte: subir y «Leer con IA» ──
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);

  async function upload(file: File) {
    setErr(null);
    setAiNote(null);
    if (!/^(image\/(jpeg|jpg|png|webp)|application\/pdf)$/.test(file.type) || file.size > 15 * 1024 * 1024) {
      setErr(t("errAttachFormat"));
      return;
    }
    setUploadBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/operator/expenses/attachments", { method: "POST", body: fd }).catch(() => null);
    setUploadBusy(false);
    if (!r || !r.ok) {
      setErr(t("errAttachFormat"));
      return;
    }
    const j = (await r.json()) as { fileUrl: string };
    setAttachmentUrl(j.fileUrl);
  }

  async function readWithAi() {
    if (!attachmentUrl) return;
    setErr(null);
    setAiNote(null);
    setAiBusy(true);
    const fd = new FormData();
    fd.append("fileUrl", attachmentUrl);
    fd.append("read", "1");
    const r = await fetch("/api/operator/expenses/attachments", { method: "POST", body: fd }).catch(() => null);
    setAiBusy(false);
    const j = (r && r.ok ? await r.json().catch(() => null) : null) as { prefill?: Prefill; aiError?: string } | null;
    if (!j?.prefill) {
      const key =
        j?.aiError === "ai_unavailable"
          ? "expenseAiUnavailable"
          : j?.aiError === "not_a_document"
            ? "expenseAiNotDocument"
            : "expenseAiFailed";
      setAiNote({ tone: "warn", text: t(key) });
      return;
    }
    applyPrefill(j.prefill);
  }

  function applyPrefill(p: Prefill) {
    if (p.documentType) setDocumentType(p.documentType);
    if (p.documentNumber) setDocumentNumber(p.documentNumber);
    if (p.documentDate) setDocumentDate(p.documentDate);
    if (p.subtotalCents) setAmountRaw(centsToRaw(p.subtotalCents));
    const hasTax = (p.ivaCents ?? 0) > 0 || (p.incCents ?? 0) > 0 || (p.discountCents ?? 0) > 0;
    if (hasTax || p.documentType === "e_invoice") {
      setTaxMode(true);
      setTaxOpen(true);
      setDiscountRaw(centsToRaw(p.discountCents));
      if (p.ivaPct != null) setIvaPct(p.ivaPct);
      setIvaPrintedRaw(p.ivaCents != null && p.ivaCents > 0 ? centsToRaw(p.ivaCents) : "");
      setIncRaw(centsToRaw(p.incCents));
    }
    const notes = [t("expenseAiDone")];
    if (p.supplierId) {
      const s = supplierOptions.find((x) => x.id === p.supplierId);
      setSupplierId(p.supplierId);
      if (s) notes.push(t("expenseAiSupplierFound", { name: s.name }));
    } else if (p.supplierName) {
      setPrefillName({ name: p.supplierName, taxId: p.supplierTaxId });
      notes.push(t("expenseAiSupplierNew", { name: p.supplierName }));
    }
    setAiNote({ tone: "ok", text: notes.join(" ") });
  }

  /**
   * `possibleDuplicate`: "check" pide al servidor la advertencia de un
   * documento sin número igual a otro (mismo proveedor, día y total);
   * "allow" guarda igual, después de que el operador la vio.
   */
  async function save(possibleDuplicate: "check" | "allow" = "check") {
    setErr(null);
    setDup(null);
    // No guardar impuestos con IVA descontable/sugerencias aún desconocidos.
    if (taxMode && !taxCtx) {
      setErr(t(taxLoadError ? "expenseTaxLoadError" : "loading"));
      return;
    }
    const cat = category.trim();
    if (!cat || !date) {
      setErr(t("errExpenseInvalid"));
      return;
    }
    if (subtotalCents < 1 || amounts.baseCents < 1) {
      setErr(t("errAmountInvalid"));
      return;
    }
    const day = Number(dayRaw);
    if (recurring && (!Number.isInteger(day) || day < 1 || day > 28)) {
      setErr(t("errRecurringDayRequired"));
      return;
    }
    if (taxMode) {
      for (const l of lines) {
        const limit = l.kind === "reteiva" ? amounts.ivaCents : amounts.baseCents;
        if (lineAmount(l) > limit) {
          setErr(t("errExpenseRetentionExceeds"));
          return;
        }
      }
      if (amounts.payableCents < 1) {
        setErr(t("errExpensePayableNotPositive"));
        return;
      }
      if ((amounts.ivaCents > 0 || amounts.retentionsCents > 0) && !supplierId) {
        setErr(t("errExpenseSupplierRequired"));
        return;
      }
    }
    if (!expense && !recurring && paidNow && accountsLoading) {
      setErr(t("loading"));
      return;
    }
    const outstandingNow = expense ? expenseOutstandingCents(expense) : 0;
    // recurringDay: null explícito al apagar recurrente — el PATCH valida
    // el estado resultante (existente + parche) y un día huérfano es 400.
    const body = {
      category: cat,
      description: description.trim() || null,
      subtotalCents,
      discountCents: taxInput.discountCents,
      ivaPct: taxInput.ivaPct,
      ivaCents: taxInput.ivaCents,
      incCents: taxInput.incCents,
      retentions: lines
        .map((l) => ({
          ...(l.conceptId ? { conceptId: l.conceptId } : { sourceId: l.sourceId }),
          amountCents: lineAmount(l),
        }))
        .filter((l) => l.amountCents > 0),
      documentType,
      documentNumber: documentNumber.trim() || null,
      documentDate: documentDate ? dateInputToIso(documentDate) : null,
      attachmentUrl,
      date: dateInputToIso(date),
      supplierId: supplierId || null,
      costCenterId: costCenterId || null,
      recurring,
      recurringDay: recurring ? day : null,
      accountCode: accountCode || null,
      // Al crear: vence sólo si quedó debiéndose. Al editar: el vencimiento
      // del saldo que queda (si ya está pagado no se toca).
      ...(expense
        ? outstandingNow > 0 && !recurring
          ? { dueAt: dueDate ? dateInputToIso(dueDate) : null }
          : {}
        : { dueAt: !recurring && !paidNow && dueDate ? dateInputToIso(dueDate) : null }),
      // Solo al CREAR: el abono de contado se hace en la misma transacción.
      // Editando, los pagos se registran por su propia ruta.
      ...(expense ? {} : { payFromAccountCode: !recurring && paidNow ? payAccountCode || null : null }),
      possibleDuplicate,
    };
    setBusy(true);
    const r = await fetch(
      expense ? `/api/operator/expenses/${expense.id}` : "/api/operator/expenses",
      {
        method: expense ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) {
      const j = r ? await r.json().catch(() => ({})) : {};
      // Factura del proveedor ya registrada (o un gasto sin número igual a
      // otro): se dice cuál, con su enlace, en vez de «No se pudo guardar».
      const conflict = r?.status === 409 ? parseDuplicateConflict(j) : null;
      if (conflict) {
        setDup(conflict);
        return;
      }
      const key = API_ERROR_KEYS[(j as { error?: string }).error ?? ""];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    onChanged();
  }

  // Borrar plantilla: las copias ya materializadas quedan (contrato del
  // API) — el confirm lo aclara. Confirm nativo, patrón compras/recetas.
  async function remove() {
    if (!expense) return;
    const msg = expense.recurring
      ? t("confirmDeleteExpenseTemplate")
      : t("confirmDeleteExpense");
    if (!window.confirm(msg)) return;
    setErr(null);
    setDeletingBusy(true);
    const r = await fetch(`/api/operator/expenses/${expense.id}`, {
      method: "DELETE",
    });
    setDeletingBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = API_ERROR_KEYS[(j as { error?: string }).error ?? ""];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    onChanged();
  }

  const anyBusy = busy || deletingBusy || uploadBusy || aiBusy;
  // Aviso temprano mientras se digita: esa factura de ese proveedor ya está
  // registrada (como compra o como gasto). Sólo avisa; el servidor bloquea.
  const earlyDup = useDuplicateDocumentCheck({
    supplierId: !recurring && documentType !== "none" ? supplierId || null : null,
    number: documentNumber,
    excludeExpenseId: expense?.id ?? null,
  });
  const expenseNumber = formatExpenseNumber(expense?.number);
  const title = expenseNumber
    ? t("expenseSheetTitleNumbered", { number: expenseNumber })
    : expense
      ? expense.recurring
        ? t("expenseSheetTitleTemplate")
        : t("editExpense")
      : t("newExpense");
  const subtitle = !expense
    ? t("expenseSheetNumberOnSave")
    : expense.recurring
      ? t("expenseSheetTemplateHint")
      : expenseOutstandingCents(expense) > 0
        ? t("expenseOutstandingBadge", { amount: money(expenseOutstandingCents(expense)) })
        : expense.paidAt
          ? t("expensePaidFull", { date: formatDate(expense.paidAt, { locale, timeStyle: undefined }) })
          : t("expenseSheetEditHint");
  const showCenters = centers.length > 0 || costCenterId !== "";
  const taxSummary = taxMode
    ? t("expenseTaxSummaryCollapsed", { amount: money(amounts.payableCents) })
    : t("expenseTaxSectionHint");
  const docSummary =
    documentType !== "none" || documentNumber.trim()
      ? [documentType !== "none" ? t(`expenseDocType_${documentType}`) : "", documentNumber.trim()]
          .filter(Boolean)
          .join(" ")
      : attachmentUrl
        ? t("expenseAttachAttached")
        : t("expenseDocSectionHint");

  return (
    <div
      // Sin cierre al tocar afuera: es un formulario, y un clic perdido borraba lo digitado.
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
    >
      <div
        // Más ancha en escritorio: los campos van de a dos o tres por fila y
        // el formulario cabe casi sin desplazarse. Las acciones quedan fijas
        // abajo (ver el pie), así Guardar siempre está a la vista.
        className="w-full md:max-w-2xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border px-5 pt-5 sm:px-6 max-h-[92dvh] overflow-y-auto overscroll-contain"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h2 className="font-display text-2xl">{title}</h2>
            <p className="text-xs text-op-muted mt-0.5">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center text-op-muted hover:text-op-text shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2 rounded-[var(--radius-btn)]"
            aria-label={t("cancel")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
              <path d="m6 6 12 12M6 18 18 6" />
            </svg>
          </button>
        </div>

        <div className="space-y-3">
          {/* Lo esencial en una grilla: escritorio, Categoría | Fecha y
              Proveedor | Valor; celular, Categoría, Proveedor y Valor | Fecha. */}
          <div className="grid grid-cols-6 gap-3">
            <div className="col-span-6 order-1 sm:col-span-4">
              <Field label={t("fieldCategory")} required>
                <input
                  type="text"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder={t("expenseCategoryPlaceholder")}
                  maxLength={60}
                  list="expense-categories"
                  className={inputCls}
                />
                <datalist id="expense-categories">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </Field>
            </div>
            <div className={(taxMode ? "col-span-6" : "col-span-3") + " order-4 sm:col-span-2 sm:order-2"}>
              <Field label={t("fieldDate")} required>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className={inputCls}
                />
              </Field>
            </div>
            {/* Proveedor: UN solo campo (valor = id) que elige o pide crear
                ahí mismo. `onCreateRequested(texto)` abre el alta rápida con
                ese nombre, sin salir del gasto. */}
            <div className="col-span-6 order-2 sm:col-span-3 sm:order-3">
              <SupplierSlot
                label={t("fieldSupplier")}
                required={taxMode && (amounts.ivaCents > 0 || amounts.retentionsCents > 0)}
                value={supplierId}
                options={supplierOptions}
                onChange={selectSupplier}
                onCreateRequested={(text) => setCreateSupplierText(text)}
              />
              {prefillName && !supplierId && (
                <p className="text-[11px] text-op-muted mt-0.5">
                  {t("expenseAiSupplierNew", { name: prefillName.name })}
                </p>
              )}
            </div>
            {/* Con impuestos el rótulo y la ayuda son largos: a todo el ancho en el celular. */}
            <div className={(taxMode ? "col-span-6" : "col-span-3") + " order-3 sm:col-span-3 sm:order-4"}>
              <Field
                label={taxMode ? t("expenseSubtotalLabel") : t("fieldAmount")}
                required
                hint={taxMode ? t("expenseSubtotalHint") : undefined}
              >
                <MoneyInput
                  value={amountRaw}
                  onChange={setAmountRaw}
                  fractionDigits={2}
                  className={inputCls}
                />
              </Field>
            </div>
          </div>

          <Field label={t("fieldDescription")}>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={300}
              className={inputCls}
            />
          </Field>

          {/* ── Documento soporte ── */}
          <Disclosure
            title={t("expenseDocSection")}
            summary={docSummary}
            open={docOpen}
            onToggle={() => setDocOpen((v) => !v)}
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className={documentType !== "none" ? "col-span-2 sm:col-span-1" : "col-span-2 sm:col-span-3"}>
            <Field label={t("fieldDocType")}>
              <select
                value={documentType}
                onChange={(e) => {
                  const v = e.target.value as ExpenseDocumentType;
                  setDocumentType(v);
                  openTaxesIfImplied({ documentType: v });
                }}
                className={inputCls}
              >
                {EXPENSE_DOCUMENT_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {t(`expenseDocType_${d}`)}
                  </option>
                ))}
              </select>
            </Field>
            </div>
            {documentType !== "none" && (
              <>
                <Field label={t("fieldDocNumber")}>
                  <input
                    type="text"
                    value={documentNumber}
                    onChange={(e) => setDocumentNumber(e.target.value)}
                    maxLength={60}
                    className={inputCls}
                  />
                </Field>
                <Field label={t("fieldDocDate")}>
                  <input
                    type="date"
                    value={documentDate}
                    onChange={(e) => setDocumentDate(e.target.value)}
                    className={inputCls}
                  />
                </Field>
              </>
            )}
            </div>
            {earlyDup && !dup && (
              <DuplicateDocumentAlert code="early" existing={earlyDup} currency={currency} />
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
            {attachmentUrl ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-op-muted">{t("expenseAttachAttached")}</span>
                <a
                  href={attachmentUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mp-btn mp-btn--sm mp-btn--secondary"
                >
                  {t("expenseAttachView")}
                </a>
                <button
                  type="button"
                  onClick={() => void readWithAi()}
                  disabled={anyBusy}
                  className="mp-btn mp-btn--sm mp-btn--secondary"
                >
                  {aiBusy ? t("expenseAiBusy") : t("expenseAiRead")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAttachmentUrl(null);
                    setAiNote(null);
                  }}
                  className="mp-btn mp-btn--sm mp-btn--ghost"
                >
                  {t("expenseAttachRemove")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={anyBusy}
                className="mp-btn mp-btn--sm mp-btn--secondary"
              >
                {uploadBusy ? t("expenseAttachBusy") : t("expenseAttach")}
              </button>
            )}
            {aiNote && (
              <p role="status" className={`text-xs ${aiNote.tone === "ok" ? "text-op-text" : "text-[#7F5A1F]"}`}>
                {aiNote.text}
              </p>
            )}
          </Disclosure>

          {/* ── Impuestos y retenciones ── */}
          <Disclosure
            title={t("expenseTaxSection")}
            summary={taxSummary}
            open={taxOpen}
            onToggle={() => {
              setTaxMode(true);
              setTaxOpen((v) => !v);
            }}
          >
            <div>
              <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
                {t("fieldIvaRate")}
              </div>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("fieldIvaRate")}>
                {(taxCtx?.ivaRates ?? [0, 5, 19]).map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    role="radio"
                    aria-checked={ivaPct === pct}
                    onClick={() => setIvaPct(pct)}
                    className={
                      "min-h-[40px] min-w-[56px] px-3 rounded-full border text-sm tabular-nums " +
                      (ivaPct === pct
                        ? "bg-ink text-paper border-ink"
                        : "bg-op-bg border-op-border text-op-text")
                    }
                  >
                    {t("ivaRateChip", { pct })}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t("fieldDiscount")} hint={t("fieldDiscountHint")}>
                <MoneyInput value={discountRaw} onChange={setDiscountRaw} fractionDigits={2} className={inputCls} />
              </Field>
              <Field label={t("fieldIvaPrinted")} hint={t("fieldIvaPrintedHint")}>
                <MoneyInput
                  value={ivaPrintedRaw}
                  onChange={setIvaPrintedRaw}
                  fractionDigits={2}
                  placeholder={pre.ivaCents > 0 && printedIva == null ? String(pre.ivaCents / 100) : undefined}
                  className={inputCls}
                />
              </Field>
              <Field label={t("fieldInc")} hint={t("fieldIncHint")}>
                <MoneyInput value={incRaw} onChange={setIncRaw} fractionDigits={2} className={inputCls} />
              </Field>
            </div>
            {amounts.ivaCents > 0 && (
              <p className="text-[11px] text-op-muted">
                {ivaDeductible ? t("expenseIvaDeductible") : t("expenseIvaNotDeductible")}
              </p>
            )}

            {/* Retenciones practicadas */}
            <div className="rounded-xl border border-op-border bg-op-bg/50 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{t("expenseRetTitle")}</span>
                {retLines !== null && activeConcepts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setRetLines(null)}
                    className="text-[11px] font-medium text-op-muted hover:text-ink min-h-[32px]"
                  >
                    {t("expenseRetReset")}
                  </button>
                )}
              </div>
              {taxLoadError ? (
                <div role="alert" className="space-y-2">
                  <p className="text-xs text-danger">{t("expenseTaxLoadError")}</p>
                  <button type="button" onClick={retryTaxContext} className="mp-btn mp-btn--secondary mp-btn--sm">
                    {t("expenseTaxRetry")}
                  </button>
                </div>
              ) : !taxCtx ? (
                <p className="text-xs text-op-muted">{t("loading")}</p>
              ) : concepts.length === 0 && lines.length === 0 ? (
                <p className="text-xs text-op-muted">{t("expenseRetNoConcepts")}</p>
              ) : (
                <>
                  <p className="text-xs text-op-muted">{t("expenseRetManualHint")}</p>
                  {lines.length === 0 ? (
                    <p className="text-xs text-op-muted">{t("expenseRetNone")}</p>
                  ) : (
                    <ul className="space-y-2">
                      {lines.map((l, i) => (
                        <li key={l.conceptId ?? l.sourceId ?? i} className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm truncate">{l.name}</div>
                            <div className="text-[11px] text-op-muted">
                              {l.base === "tax"
                                ? t("expenseRetOnTax", { rate: fmtRate(l.rateBps, locale) })
                                : t("expenseRetOnBase", { rate: fmtRate(l.rateBps, locale) })}
                            </div>
                          </div>
                          <MoneyInput
                            value={String(lineAmount(l) / 100)}
                            fractionDigits={2}
                            onChange={(raw) =>
                              editLines((cur) =>
                                cur.map((x, j) => (j === i ? { ...x, amount: rawToCents(raw) } : x)),
                              )
                            }
                            ariaLabel={l.name}
                            className="w-32 min-h-[44px] px-3 rounded-lg border border-op-border bg-op-surface text-sm text-right tabular-nums"
                          />
                          <button
                            type="button"
                            onClick={() => editLines((cur) => cur.filter((_, j) => j !== i))}
                            aria-label={t("expenseRetRemove", { name: l.name })}
                            className="min-h-[44px] min-w-[40px] text-op-muted hover:text-ink"
                          >
                            {"✕"}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {retLines === null && lines.length > 0 && (
                    <p className="text-[11px] text-op-muted">{t("expenseRetSuggested")}</p>
                  )}
                  {addable.length > 0 && (
                    <select
                      value=""
                      onChange={(e) => {
                        const c = concepts.find((x) => x.id === e.target.value);
                        if (!c) return;
                        editLines((cur) => [
                          ...cur,
                          { conceptId: c.id, kind: c.kind, name: c.name, rateBps: c.rateBps, base: c.base, amount: null },
                        ]);
                      }}
                      className={inputCls}
                      aria-label={t("expenseRetAdd")}
                    >
                      <option value="">{t("expenseRetAdd")}</option>
                      {addable.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.active ? c.name : t("expenseRetManualOption", { name: c.name })}
                        </option>
                      ))}
                    </select>
                  )}
                </>
              )}
            </div>

            {/* Resumen en vivo */}
            <dl className="rounded-xl border border-op-border bg-op-surface px-3 py-2.5 space-y-1 text-sm" aria-live="polite">
              <SummaryRow label={t("expenseSumBase")} value={money(amounts.baseCents)} />
              {amounts.discountCents > 0 && (
                <SummaryRow label={t("expenseSumDiscount")} value={`− ${money(amounts.discountCents)}`} muted />
              )}
              <SummaryRow
                label={amounts.ivaPct > 0 && printedIva == null ? t("expenseSumIvaPct", { pct: amounts.ivaPct }) : t("expenseSumIva")}
                value={money(amounts.ivaCents)}
              />
              {amounts.incCents > 0 && <SummaryRow label={t("expenseSumInc")} value={money(amounts.incCents)} />}
              {amounts.retentionsCents > 0 && (
                <SummaryRow label={t("expenseSumRetentions")} value={`− ${money(amounts.retentionsCents)}`} />
              )}
              <div className="flex items-baseline justify-between gap-3 border-t border-op-border pt-1.5 mt-1">
                <dt className="font-medium">{t("expenseSumPayable")}</dt>
                <dd className="font-semibold tabular-nums">{money(amounts.payableCents)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-op-muted">{t("expenseSumCost")}</dt>
                <dd className="tabular-nums text-op-muted">{money(amounts.costCents)}</dd>
              </div>
              <p className="text-[10px] text-op-muted">{t("expenseSumCostHint")}</p>
            </dl>
          </Disclosure>

          <div className={showCenters && accounts.length > 0 ? "grid grid-cols-1 gap-3 sm:grid-cols-2" : "space-y-3"}>
          {/* Cuenta contable del gasto. Vacío = se deriva de la categoría por
              palabras clave, que es lo que se hacía siempre; con plan de
              cuentas propio conviene fijarla. */}
          {accounts.length > 0 && (
            <ComboField label={t("fieldExpenseAccount")} htmlFor="expense-account" hint={t("expenseAccountHint")}>
              {/* Se escribe el código («5135») o el nombre; la primera
                  opción, vacía, es «Automática (por la categoría)». */}
              <AccountCombobox
                id="expense-account"
                accounts={accounts.filter((a) => a.type === "gasto" || a.type === "costo")}
                value={accountCode || null}
                onChange={(code) => setAccountCode(code ?? "")}
                emptyLabel={t("expenseAccountAuto")}
              />
            </ComboField>
          )}

          {/* Centro de costos (opcional) — solo si el comercio creó alguno. */}
          {showCenters && (
            <Field label={t("fieldCostCenter")}>
              <select
                value={costCenterId}
                onChange={(e) => setCostCenterId(e.target.value)}
                className={inputCls}
              >
                <option value="">{t("noCostCenter")}</option>
                {centers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                {costCenterId !== "" &&
                  !centers.some((c) => c.id === costCenterId) &&
                  expense?.costCenter && (
                    <option value={costCenterId}>{expense.costCenter.name}</option>
                  )}
              </select>
            </Field>
          )}

          </div>

          {!recurring && !expense && (
            <div className="rounded-2xl border border-op-border bg-op-bg/50 p-3 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] sm:items-end sm:gap-3">
              <label className="flex items-center gap-2 min-h-[44px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={paidNow}
                  onChange={(e) => setPaidNow(e.target.checked)}
                  className="w-4 h-4 accent-ink"
                />
                <span className="text-sm">{t("expensePaidNow")}</span>
              </label>
              {paidNow ? (
                <CashAccountField
                  id="expense-pay-from"
                  label={t("fieldPayFromAccount")}
                  hint={
                    amounts.payableCents > 0
                      ? t("expensePaidNowAmount", { amount: money(amounts.payableCents) })
                      : t("payFromAccountHint")
                  }
                  accounts={accounts.filter((a) => a.code.startsWith("11"))}
                  value={payAccountCode}
                  onChange={setPayAccountCode}
                />
              ) : (
                <Field label={t("fieldDueDate")} hint={t("expenseOwedHint")}>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className={inputCls}
                  />
                </Field>
              )}
            </div>
          )}

          {/* Gasto que quedó debiéndose: el pago se registra acá. */}
          {expense && !expense.recurring && (
            <>
              {expenseOutstandingCents(expense) > 0 && (
                <Field label={t("fieldDueDate")} hint={t("expenseOwedHint")}>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className={inputCls}
                  />
                </Field>
              )}
              <ExpensePaymentPanel
                expense={expense}
                currency={currency}
                accounts={accounts}
                onPaid={onChanged}
              />
              {/* Documento soporte DIAN (proveedor no obligado a facturar). */}
              <SupportDocumentPanel sourceType="expense" sourceId={expense.id} currency={currency} />
            </>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-start sm:gap-3">
          <label className="flex items-center gap-2 min-h-[44px] cursor-pointer">
            <input
              type="checkbox"
              checked={recurring}
              onChange={(e) => setRecurring(e.target.checked)}
              className="w-4 h-4 accent-ink"
            />
            <span className="text-sm">{t("recurringToggle")}</span>
          </label>

          {recurring && (
            <Field
              label={t("fieldRecurringDay")}
              required
              hint={taxMode && lines.length > 0 ? `${t("recurringDayHint")} ${t("recurringTaxHint")}` : t("recurringDayHint")}
            >
              <input
                type="number"
                min={1}
                max={28}
                step={1}
                inputMode="numeric"
                value={dayRaw}
                onChange={(e) => setDayRaw(e.target.value)}
                className={inputCls}
              />
            </Field>
          )}
          </div>

          {inactiveRecurringNames.length > 0 && (
            <div role="note" className="rounded-xl border border-op-border bg-op-bg p-3 space-y-2 text-xs text-op-muted">
              <p>{t("expenseRetRecurringInactive", { names: inactiveRecurringNames.join(", ") })}</p>
              <a href="/operator/contabilidad?tab=impuestos" target="_blank" rel="noopener noreferrer"
                className="inline-flex min-h-[44px] items-center font-medium text-op-text underline underline-offset-4">
                {t("expenseRetConfigure")}
              </a>
            </div>
          )}

          {dup && (
            <DuplicateDocumentAlert
              code={dup.code}
              existing={dup.existing}
              currency={currency}
              busy={busy}
              onConfirm={dup.code === "possible_duplicate" ? () => void save("allow") : undefined}
            />
          )}

          {err && (
            <div role="alert" className="text-xs text-danger">
              {err}
            </div>
          )}

          {/* Eliminar, en el celular, al final del formulario: el pie fijo
              queda en una sola fila (Cancelar | Guardar). */}
          {expense && (
            <div className="sm:hidden pt-1">
              <button
                type="button"
                onClick={remove}
                disabled={anyBusy}
                className="mp-btn mp-btn--danger mp-btn--block"
              >
                {deletingBusy ? t("deleting") : t("deleteItem")}
              </button>
            </div>
          )}

          {/* Acciones fijas al pie de la hoja (siempre a la vista): en el
              celular, Cancelar | Guardar en una fila de dos; en escritorio,
              una sola fila con Eliminar a la izquierda. El padding reserva
              la franja del indicador de inicio en la PWA de iOS (env() = 0
              en escritorio). */}
          <div
            className="sticky bottom-0 z-10 -mx-5 sm:-mx-6 px-5 sm:px-6 pt-3 mt-1 border-t border-op-border bg-op-surface flex flex-col gap-3 sm:flex-row sm:items-center"
            style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" }}
          >
            {expense && (
              // .mp-btn fija su display: el «sólo en escritorio» va en el envoltorio.
              <span className="hidden sm:block">
                <button
                  type="button"
                  onClick={remove}
                  disabled={anyBusy}
                  className="mp-btn mp-btn--danger"
                >
                  {deletingBusy ? t("deleting") : t("deleteItem")}
                </button>
              </span>
            )}
            <div className="hidden sm:block sm:flex-1" />
            <div className="grid grid-cols-2 gap-3 sm:flex">
              <button
                type="button"
                onClick={onClose}
                className="mp-btn mp-btn--secondary"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={
                  anyBusy ||
                  (taxMode && !taxCtx) ||
                  (!expense && !recurring && paidNow && accountsLoading) ||
                  category.trim() === "" ||
                  amountRaw.trim() === ""
                }
                className="mp-btn mp-btn--primary"
              >
                {busy ? t("saving") : t("save")}
              </button>
            </div>
          </div>
        </div>
      </div>

      {createSupplierText !== null && (
        <SupplierQuickCreate
          // Lo que se escribió en el campo: si parece un documento (sólo
          // dígitos, puntos, guiones), va al número; si no, al nombre.
          initialName={(createSupplierText && !looksLikeTaxId(createSupplierText) ? createSupplierText : "") || prefillName?.name || ""}
          initialTaxId={(createSupplierText && looksLikeTaxId(createSupplierText) ? createSupplierText : "") || prefillName?.taxId || ""}
          onCreated={handleSupplierCreated}
          onCancel={() => setCreateSupplierText(null)}
        />
      )}
    </div>
  );
}

/* ─────────────────────────── Campo proveedor ───────────────────────── */

/**
 * El campo «Proveedor» del gasto: el buscador compartido de proveedores
 * (se escribe el nombre o el NIT y se elige; la última opción es «Crear
 * proveedor «lo escrito»», que abre el alta rápida de este formulario).
 */
function SupplierSlot({
  label,
  required,
  value,
  options,
  onChange,
  onCreateRequested,
}: {
  label: string;
  required?: boolean;
  value: string;
  options: SupplierRef[];
  onChange: (id: string) => void;
  onCreateRequested: (text: string) => void;
}) {
  return (
    <div className="min-w-0">
      <label
        htmlFor="expense-supplier"
        className="block font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1"
      >
        {label}
        {required && <span className="text-danger ml-1">{"*"}</span>}
      </label>
      <SupplierCombobox
        id="expense-supplier"
        suppliers={options}
        value={value || null}
        onChange={(id) => onChange(id ?? "")}
        onCreateRequested={onCreateRequested}
      />
    </div>
  );
}

/* ──────────────────────── Sección desplegable ──────────────────────── */

function Disclosure({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-op-border bg-op-bg/40">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full min-h-[52px] px-3 py-2 flex items-center justify-between gap-3 text-left"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-[11px] text-op-muted truncate">{summary}</span>
        </span>
        <span className="text-xs text-op-muted shrink-0" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && <div className="px-3 pb-3 space-y-3">{children}</div>}
    </section>
  );
}

function SummaryRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${muted ? "text-op-muted" : ""}`}>
      <dt className="text-op-muted">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/* ─────────────── Registrar el pago de un gasto por pagar ────────────── */

/**
 * Pago (total o abono) de un gasto que quedó debiéndose: POST
 * /api/operator/expenses/[id]/payments con el monto, la fecha y la cuenta
 * de donde salió la plata. El saldo es el TOTAL A PAGAR (lo retenido no se
 * le paga al proveedor) menos lo abonado.
 */
function ExpensePaymentPanel({
  expense,
  currency,
  accounts,
  onPaid,
}: {
  expense: ExpenseDto;
  currency: string;
  accounts: ChartAccountRef[];
  onPaid: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const outstanding = expenseOutstandingCents(expense);
  const cashAccounts = accounts.filter((a) => a.code.startsWith("11"));
  const [amountRaw, setAmountRaw] = useState(String(outstanding / 100));
  const [date, setDate] = useState(todayDateInput());
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const accountCode = account || cashAccounts[0]?.code || "";

  // Saldado: lo dice el encabezado de la hoja («Pagado el …»).
  if (outstanding <= 0) return null;

  async function pay() {
    setErr(null);
    const amountCents = rawToCents(amountRaw);
    if (amountCents < 1) {
      setErr(t("errAmountInvalid"));
      return;
    }
    if (amountCents > outstanding) {
      setErr(t("errExpensePayExceeds"));
      return;
    }
    if (!date || !accountCode) {
      setErr(t("errExpenseInvalid"));
      return;
    }
    setBusy(true);
    const r = await fetch(`/api/operator/expenses/${expense.id}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountCents, paidAt: dateInputToIso(date), accountCode }),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = API_ERROR_KEYS[(j as { error?: string }).error ?? ""];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    onPaid();
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-bg/50 p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{t("expensePayTitle")}</span>
        <span className="text-[11px] text-op-muted tabular-nums">
          {t("expensePayOutstanding", { amount: formatMoney(outstanding, { currency, locale, fractionDigits: "auto" }) })}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <Field label={t("expensePayAmount")} required>
        <MoneyInput value={amountRaw} onChange={setAmountRaw} fractionDigits={2} className={inputCls} />
      </Field>
      <Field label={t("expensePayDate")} required>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className={inputCls}
        />
      </Field>
      <div className="col-span-2 sm:col-span-1">
      <CashAccountField
        id={`expense-pay-${expense.id}`}
        label={t("fieldPayFromAccount")}
        hint={t("payFromAccountHint")}
        accounts={cashAccounts}
        value={accountCode}
        onChange={setAccount}
      />
      </div>
      </div>
      {err && <div role="alert" className="text-xs text-danger">{err}</div>}
      <button
        type="button"
        onClick={pay}
        disabled={busy || !accountCode}
        className="mp-btn mp-btn--secondary mp-btn--block"
      >
        {busy ? t("expensePayBusy") : t("expensePayButton")}
      </button>
    </div>
  );
}

/* ─────────────── Nuevo proveedor sin salir del gasto ────────────────── */

type DuplicateSupplier = { id: string; name: string; taxId: string | null };

/**
 * Hoja encima del gasto (en el celular sube desde abajo, en escritorio es un
 * diálogo): nombre, tipo y número de documento —el DV del NIT se calcula y
 * se valida con la misma regla de la factura electrónica—, tipo de persona y
 * plazo de pago. Usa la misma API de Proveedores (POST /api/operator/
 * suppliers), que normaliza el documento y avisa si ya existe un proveedor
 * con ese nombre o ese NIT: en ese caso se ofrece usarlo.
 */
export function SupplierQuickCreate({
  initialName = "",
  initialTaxId = "",
  onCreated,
  onCancel,
}: {
  initialName?: string;
  initialTaxId?: string;
  onCreated: (s: SupplierRef) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("opErp");
  const [name, setName] = useState(initialName);
  const [docType, setDocType] = useState<SupplierTaxIdType>("NIT");
  const [docNumber, setDocNumber] = useState(initialTaxId);
  const [personType, setPersonType] = useState<SupplierPersonType>("juridica");
  const [personTouched, setPersonTouched] = useState(false);
  const [termsRaw, setTermsRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateSupplier | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const normalized = docNumber.trim() ? normalizeSupplierTaxId(docType, docNumber) : null;
  const docError =
    normalized && !normalized.ok
      ? normalized.error === "invalid_verification_digit"
        ? t("errSupplierDvInvalid")
        : t("errSupplierDocInvalid")
      : null;

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setErr(t("errExpenseInvalid"));
      return;
    }
    if (docError) {
      setErr(docError);
      return;
    }
    const terms = termsRaw.trim();
    const paymentTermsDays = terms === "" ? undefined : Number(terms);
    if (
      paymentTermsDays !== undefined &&
      (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 365)
    ) {
      setErr(t("errExpenseInvalid"));
      return;
    }
    setErr(null);
    setDuplicate(null);
    setBusy(true);
    const r = await fetch("/api/operator/suppliers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: trimmed,
        taxId: docNumber.trim() || undefined,
        taxIdType: docNumber.trim() ? docType : undefined,
        personType,
        paymentTermsDays,
      }),
    }).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) {
      const j = (r ? await r.json().catch(() => ({})) : {}) as { error?: string; existing?: DuplicateSupplier };
      if ((j.error === "tax_id_taken" || j.error === "name_taken") && j.existing) {
        setDuplicate(j.existing);
        setErr(
          j.error === "tax_id_taken"
            ? t("errSupplierTaxIdTaken", { name: j.existing.name })
            : t("errSupplierNameTakenExisting", { name: j.existing.name }),
        );
        return;
      }
      setErr(
        j.error === "invalid_verification_digit"
          ? t("errSupplierDvInvalid")
          : j.error === "invalid_document"
            ? t("errSupplierDocInvalid")
            : t("errSaveFailed"),
      );
      return;
    }
    const j = (await r.json()) as { supplier: DuplicateSupplier };
    onCreated({ id: j.supplier.id, name: j.supplier.name, taxId: j.supplier.taxId });
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      // Sin cierre al tocar afuera (y sin dejar pasar el clic a la hoja del gasto).
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="w-full md:max-w-md bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[88dvh] overflow-y-auto overscroll-contain"
        style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom, 0px))" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("supplierNewTitle")}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h3 className="font-display text-xl">{t("supplierNewTitle")}</h3>
          <button
            type="button"
            onClick={onCancel}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>
        <p className="text-xs text-op-muted mb-4">{t("supplierNewIntro")}</p>

        <div className="space-y-3">
          <Field label={t("fieldName")} required>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("supplierNamePlaceholder")}
              maxLength={120}
              className={inputCls}
            />
          </Field>
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
            <Field label={t("fieldSupplierDocType")}>
              <select
                value={docType}
                onChange={(e) => {
                  const v = e.target.value as SupplierTaxIdType;
                  setDocType(v);
                  if (!personTouched) setPersonType(defaultPersonType(v));
                }}
                className={inputCls}
              >
                {SUPPLIER_TAX_ID_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {t(`supplierDocType_${d}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={t("fieldSupplierDocNumber")}
              hint={docType === "NIT" ? t("supplierDocNumberHintNit") : undefined}
            >
              <div className="relative">
                <input
                  type="text"
                  inputMode={docType === "CC" || docType === "NIT" ? "numeric" : "text"}
                  value={docNumber}
                  onChange={(e) => setDocNumber(e.target.value)}
                  maxLength={40}
                  aria-invalid={Boolean(docError)}
                  className={`${inputCls} ${normalized?.ok && normalized.verificationDigit ? "pr-16" : ""}`}
                />
                {normalized?.ok && normalized.verificationDigit && (
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-paper px-1.5 py-0.5 text-[11px] font-medium text-op-muted tabular-nums">
                    {t("supplierDv", { dv: normalized.verificationDigit })}
                  </span>
                )}
              </div>
            </Field>
          </div>
          {docError && <p className="text-xs text-danger -mt-1">{docError}</p>}
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
              {t("fieldPersonType")}
            </div>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("fieldPersonType")}>
              {(["natural", "juridica"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={personType === p}
                  onClick={() => {
                    setPersonType(p);
                    setPersonTouched(true);
                  }}
                  className={
                    "min-h-[44px] px-3 rounded-lg border text-sm " +
                    (personType === p ? "bg-ink text-paper border-ink" : "bg-op-bg border-op-border")
                  }
                >
                  {t(`personType_${p}`)}
                </button>
              ))}
            </div>
          </div>
          <Field label={t("fieldPaymentTerms")} hint={t("paymentTermsHint")}>
            <input
              type="number"
              min={0}
              max={365}
              step={1}
              inputMode="numeric"
              value={termsRaw}
              onChange={(e) => setTermsRaw(e.target.value)}
              className={inputCls}
            />
          </Field>
          {err && (
            <div role="alert" className="text-xs text-danger">
              {err}
            </div>
          )}
          {duplicate && (
            <button
              type="button"
              onClick={() => onCreated({ id: duplicate.id, name: duplicate.name, taxId: duplicate.taxId })}
              className="mp-btn mp-btn--secondary mp-btn--block"
            >
              {t("supplierUseExisting", { name: duplicate.name })}
            </button>
          )}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <button type="button" onClick={onCancel} className="mp-btn mp-btn--secondary">
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={create}
              disabled={busy || name.trim() === ""}
              className="mp-btn mp-btn--primary"
            >
              {busy ? t("saving") : t("supplierCreateSubmit")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────── UI compartida ──────────────────────── */

/**
 * Campo con un combobox adentro: rótulo con `htmlFor` (no un `<label>` que
 * envuelva, que reenviaría los toques de la lista al input).
 */
function ComboField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="block font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
        {label}
      </label>
      {children}
      {hint && <div className="text-[10px] text-op-muted mt-1">{hint}</div>}
    </div>
  );
}

/** Con más cuentas de caja/banco que esto, «Se pagó desde» se busca escribiendo. */
const CASH_SELECT_MAX = 8;

/**
 * «Se pagó desde»: un selector corriente con pocas cuentas de caja/banco
 * (lo normal: caja, uno o dos bancos, la pasarela); con muchas, el mismo
 * buscador de la cuenta del gasto.
 */
function CashAccountField({
  id,
  label,
  hint,
  accounts,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  accounts: ChartAccountRef[];
  value: string;
  onChange: (code: string) => void;
}) {
  if (accounts.length > CASH_SELECT_MAX) {
    return (
      <ComboField label={label} htmlFor={id} hint={hint}>
        <AccountCombobox
          id={id}
          accounts={accounts}
          value={value || null}
          onChange={(code) => {
            if (code) onChange(code);
          }}
          required
        />
      </ComboField>
    );
  }
  return (
    <Field label={label} hint={hint}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        {accounts.map((a) => (
          <option key={a.code} value={a.code}>
            {`${a.code} · ${a.name}`}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
        {label}
        {required && <span className="text-danger ml-1">{"*"}</span>}
      </div>
      {children}
      {hint && <div className="text-[10px] text-op-muted mt-1">{hint}</div>}
    </label>
  );
}

const inputCls =
  "w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
