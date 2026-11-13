import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { loadShiftCloseTicket } from "@/lib/print/shiftCloseQueue";
import { devicePaperFromParam } from "@/lib/print/printDestination";
import { PrintButton } from "@/app/factura/[id]/PrintButton";
import {
  THERMAL_REPORT_STYLES,
  ThermalReportReceipt,
} from "@/components/print/ThermalReportReceipt";
import { PRINT_DESTINATION_STYLES } from "@/components/print/printDestinationStyles";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("opShifts");
  return { title: t("shiftClose"), robots: { index: false, follow: false } };
}

/**
 * TIRILLA del cierre de turno: el resumen que se arranca al cerrar la
 * caja, en papel térmico (58 u 80 mm). Es el MISMO documento que sale por
 * la impresora de caja (`shiftCloseQueue.ts` → ESC/POS); acá sólo se
 * dibuja (`ThermalReportReceipt`).
 *
 * La usa «Imprimir cierre» de la pantalla del turno: con «Este
 * dispositivo» (o sin impresora de caja) se carga en el iframe oculto y se
 * imprime en UNA página del alto del documento. `?w=58` (u 80) la dibuja
 * al papel del equipo; sin él, al del comercio. `?print=1` se imprime sola
 * al abrirse en pestaña (respaldo).
 *
 * Gate: el comercio activo de la sesión; un turno ajeno es 404.
 */
export default async function ShiftTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ print?: string; w?: string }>;
}) {
  const { id } = await params;
  const { print, w } = await searchParams;
  const t = await getTranslations("opShifts");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const loaded = await loadShiftCloseTicket({
    shiftId: id,
    restaurantId,
    paperWidthMm: devicePaperFromParam(w),
  });
  if (!loaded.ok) notFound();
  const session = await auth();

  return (
    <>
      <style>{STYLES}</style>
      <div className="tirilla-shell">
        <div className="tirilla-controls no-print">
          <PrintButton
            autoPrint={print === "1"}
            agent={{ kind: "shift", shiftId: id, href: `/operator/shifts/${id}/tirilla` }}
            paperMm={loaded.paperMm}
            viewer={{
              role: session?.user?.role ?? null,
              scope: session?.user?.restaurantId ?? null,
            }}
          />
          <Link href={`/operator/shifts/${id}`} className="secondary">
            {t("detailBack")}
          </Link>
        </div>
        <ThermalReportReceipt doc={loaded.doc} paperMm={loaded.paperMm} kind="cierre" />
      </div>
    </>
  );
}

const STYLES = `
  .tirilla-shell {
    min-height: 100%;
    background: #f1f1f1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 24px 12px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: #000;
  }
  .tirilla-controls {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-bottom: 16px;
  }
  .tirilla-controls button, .tirilla-controls a {
    border: 1px solid #000;
    background: #000;
    color: #fff;
    padding: 8px 18px;
    border-radius: 999px;
    font-family: inherit;
    font-size: 12px;
    text-decoration: none;
    cursor: pointer;
    letter-spacing: 0.04em;
  }
  .tirilla-controls button:disabled { opacity: 0.6; cursor: default; }
  .tirilla-controls a.secondary { background: #fff; color: #000; }
  .tirilla-controls .print-note { flex-basis: 100%; text-align: center; font-size: 11px; color: #1e5339; }
  .tirilla-controls .print-note.warn { color: #8f6828; }
  .tirilla-controls .print-note.error { color: #b3261e; }
${PRINT_DESTINATION_STYLES}
${THERMAL_REPORT_STYLES}
  @media print {
    header, nav, aside, footer, [role="navigation"], .no-print { display: none !important; }
    body { background: #fff !important; }
    .tirilla-shell { background: #fff; padding: 0; min-height: 0; display: block; }
    @page { margin: 0; }
  }
`;
