// Helpers compartidos por la lista, el detalle y el formulario de
// comprobantes (cliente y servidor; sin dependencias de React).

export const LIST_PATH = "/operator/contabilidad/comprobantes";

/** Tipos del API (`/api/operator/accounting/entries`). */
export type EntryRow = {
  id: string;
  date: string;
  voucherNumber: number | null;
  source: string;
  memo: string | null;
  thirdPartyName: string | null;
  thirdPartyTaxId: string | null;
  status: string;
  annulledAt: string | null;
  reversalOfId: string | null;
  totalCents: number;
  lineCount: number;
};

export type DetailLine = {
  id: string;
  accountCode: string;
  accountName: string;
  costCenterId: string | null;
  costCenterName: string | null;
  debitCents: number;
  creditCents: number;
  memo: string | null;
};

export type EntryDetail = {
  id: string;
  date: string;
  voucherNumber: number | null;
  source: string;
  memo: string | null;
  thirdPartyName: string | null;
  thirdPartyTaxId: string | null;
  status: string;
  annulledAt: string | null;
  createdAt: string;
  reversalOf: { id: string; voucherNumber: number | null } | null;
  reversalOfId: string | null;
  reversedBy: { id: string; voucherNumber: number | null } | null;
  lines: DetailLine[];
  totalDebitCents: number;
  totalCreditCents: number;
  balanced: boolean;
  monthClosed: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReverse: boolean;
};

/** `#000123`; vacío sin número (espejo de formatVoucherNumber del servidor). */
export function voucherLabel(n: number | null | undefined): string {
  if (n == null) return "";
  return `#${String(n).padStart(6, "0")}`;
}

/** ISO del API (mediodía UTC) → "YYYY-MM-DD". */
export function entryYmd(iso: string): string {
  return iso.slice(0, 10);
}

/** Hoy en la zona del comercio (Bogotá), "YYYY-MM-DD". */
export function todayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Primer día del mes de `ymd`. */
export function firstOfMonth(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

/** Monedas sin centavos en MESAPAY (misma lista que ZERO_DECIMAL en @/lib/format). */
const ZERO_DECIMAL = new Set(["COP", "CLP", "PYG", "JPY"]);

export function fractionDigitsFor(currency: string): 0 | 2 {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/** "25000.50" (unidades, como entrega MoneyInput) → centavos enteros. */
export function majorToCents(raw: string): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Centavos → unidades como string para MoneyInput ("250" / "2.5"). */
export function centsToMajor(cents: number, fractionDigits: 0 | 2): string {
  if (!cents) return "";
  return fractionDigits === 0 ? String(Math.round(cents / 100)) : (cents / 100).toFixed(2);
}
