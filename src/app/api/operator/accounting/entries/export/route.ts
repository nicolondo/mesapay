import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { formatVoucherNumber, MANUAL_SOURCE } from "@/lib/erp/journalManual";
import { buildEntriesWhere, parseYmd } from "@/lib/erp/journalQuery";
import { buildReportCsv, type CsvCell } from "@/lib/erp/reportCsv";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/** Tope de comprobantes por archivo (un año de un comercio cabe de sobra). */
const EXPORT_MAX_ENTRIES = 5000;

/**
 * CSV "comprobantes detallados" (formato zenith §3.7): una fila por línea
 * de asiento, con el comprobante repetido en cada fila. Dialecto Excel-ES:
 * `;`, coma decimal, BOM (ver reportCsv.ts). Incluye los anulados: siguen
 * en el libro y su reversa los netea.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const desde = searchParams.get("desde");
  const hasta = searchParams.get("hasta");
  if (!parseYmd(desde) || !parseYmd(hasta) || desde! > hasta!) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const [t, tErp] = await Promise.all([
    getTranslations("opComprobantes"),
    getTranslations("opErp"),
  ]);
  const sourceLabel = (source: string) =>
    source === MANUAL_SOURCE
      ? t("jSource_manual")
      : tErp.has(`jSource_${source}`)
        ? tErp(`jSource_${source}`)
        : source;

  const [entries, accounts] = await Promise.all([
    db.journalEntry.findMany({
      where: buildEntriesWhere(ctx.restaurantId, { desde, hasta }),
      orderBy: [
        { date: "asc" },
        { voucherNumber: { sort: "asc", nulls: "last" } },
        { createdAt: "asc" },
      ],
      take: EXPORT_MAX_ENTRIES,
      include: {
        lines: {
          orderBy: { accountCode: "asc" },
          include: { costCenter: { select: { name: true } } },
        },
      },
    }),
    db.ledgerAccount.findMany({
      where: { restaurantId: ctx.restaurantId },
      select: { code: true, name: true },
    }),
  ]);
  const nameByCode = new Map(accounts.map((a) => [a.code, a.name]));

  const rows: CsvCell[][] = [];
  for (const e of entries) {
    const date = e.date.toISOString().slice(0, 10);
    const voucher = formatVoucherNumber(e.voucherNumber);
    const source = sourceLabel(e.source);
    for (const l of e.lines) {
      rows.push([
        date,
        voucher,
        source,
        e.memo ?? "",
        e.thirdPartyName ?? "",
        e.thirdPartyTaxId ?? "",
        l.accountCode,
        nameByCode.get(l.accountCode) ?? "",
        l.costCenter?.name ?? "",
        l.debitCents,
        l.creditCents,
      ]);
    }
  }

  const csv = buildReportCsv({
    headers: [
      t("csvDate"),
      t("csvVoucher"),
      t("csvSource"),
      t("csvMemo"),
      t("csvThirdParty"),
      t("csvTaxId"),
      t("csvAccount"),
      t("csvAccountName"),
      t("csvCostCenter"),
      t("csvDebit"),
      t("csvCredit"),
    ],
    rows,
  });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="comprobantes-${desde}-a-${hasta}.csv"`,
    },
  });
}

export const GET = secureApi(GETHandler);
