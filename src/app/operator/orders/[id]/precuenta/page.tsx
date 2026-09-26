import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { loadPrebill } from "@/lib/print/prebillData";
import { buildPrebillDocument } from "@/lib/print/prebillQueue";
import { PrintButton } from "@/app/factura/[id]/PrintButton";
import { itemDetailText } from "@/lib/invoice";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("emailInvoice");
  return { title: t("prebillTitle"), robots: { index: false, follow: false } };
}

/**
 * PRECUENTA imprimible desde el navegador — el respaldo cuando el local no
 * tiene impresora de facturas (o su agente no responde), y también lo que
 * abre "Ver precuenta" en el detalle de la mesa.
 *
 * Es el MISMO documento que sale por la térmica: se arma con
 * `buildPrebillDocument` (los mismos textos, filas y montos del payload
 * ESC/POS) y acá sólo se dibuja como tirilla estrecha, con el mismo
 * formato COMPACTO que el papel (precio flotando a la derecha del primer
 * renglón, unitario + modificadores + nota en un renglón chico). Estilo
 * POS inline como `/factura/[id]`: fondo blanco, monoespaciada, ancho del
 * papel del comercio, y al imprimir UNA sola página del alto de la
 * precuenta (`fitPageToContent`), sin el chrome del panel (ni del PWA del
 * mesero, que re-exporta esta página).
 *
 * "Imprimir" (el botón de acá) manda la precuenta al AGENTE, como las
 * comandas, y sólo si el local no tiene impresora de facturas imprime
 * esta página.
 *
 * Gate: el restaurante activo de la sesión (operador/staff) y que la
 * cuenta sea de ese comercio; una ajena es 404, no 403, para no revelar
 * que existe.
 */
export default async function PrecuentaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ print?: string }>;
}) {
  const { id } = await params;
  const { print } = await searchParams;
  const tr = await getTranslations("opTables");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{tr("noRestaurant")}</div>;

  // El mesero llega por /mesero/precuenta/[id] (re-export): su "volver"
  // es su pantalla de mesas, no la del panel (que lo rebota).
  const session = await auth();
  const isMesero = session?.user?.role === "mesero";
  const backHref = isMesero ? "/mesero/mesas" : "/operator/tables";

  const loaded = await loadPrebill({ restaurantId, orderId: id });
  if (!loaded.ok) {
    if (loaded.reason === "not_found") notFound();
    return (
      <div className="p-6 space-y-3">
        <p className="text-sm">{tr("prebillUnavailable")}</p>
        <Link href={backHref} className="text-sm underline">
          {tr("prebillBack")}
        </Link>
      </div>
    );
  }

  const doc = await buildPrebillDocument({
    data: loaded.data,
    paperWidthMm: loaded.paperWidthMm,
    currency: loaded.currency,
    locale: loaded.locale,
  });
  const paperMm = loaded.paperWidthMm <= 58 ? 58 : 80;

  return (
    <>
      <style>{POS_STYLES}</style>
      <div className="precuenta-shell">
        <div className="precuenta-controls no-print">
          <PrintButton
            autoPrint={print === "1"}
            agent={{
              kind: "prebill",
              orderId: id,
              href: isMesero
                ? `/mesero/precuenta/${id}`
                : `/operator/orders/${id}/precuenta`,
            }}
          />
          <Link href={backHref} className="secondary">
            {tr("prebillBack")}
          </Link>
        </div>

        <article
          className="receipt"
          style={{
            width: `${paperMm}mm`,
            paddingInline: `${paperMm === 80 ? 4 : 5}mm`,
          }}
          data-print-document="precuenta"
          data-print-width-mm={paperMm}
        >
          <div className="biz-name">{doc.businessName}</div>
          {doc.businessLines.length > 0 && (
            <div className="meta">{doc.businessLines.join(" · ")}</div>
          )}

          <hr className="dashed" />

          <div className="title">{doc.title}</div>
          <div className="not-invoice">{doc.notInvoiceLine}</div>

          <hr className="dashed" />

          {/* De a dos por fila (fecha · mesa, mesero): como el papel. */}
          <div className="meta-rows">
            {doc.metaRows.map((row, i) => (
              <span key={i}>{`${row.label} ${row.value}`.trim()}</span>
            ))}
          </div>

          <hr className="dashed" />

          <div className="items">
            {doc.items.map((it, i) => {
              const detail = [
                it.unit ? tr("prebillQtyUnit", { qty: it.qty, unit: it.unit }) : "",
                itemDetailText(it),
              ]
                .filter((d) => d.length > 0)
                .join(" · ");
              return (
                <div className="item" key={i}>
                  <div className="line">
                    <span className="amount">{it.amount}</span>
                    <span className="qty">{tr("prebillQty", { qty: it.qty })}</span>
                    {" " + it.name}
                  </div>
                  {detail && <div className="hung">{detail}</div>}
                </div>
              );
            })}
          </div>

          <hr className="dashed" />

          <div className="totals">
            {doc.totals.map((row, i) => (
              <div className={row.strong ? "row grand" : "row"} key={i}>
                <span>{row.label}</span>
                <span className="right">{row.amount}</span>
              </div>
            ))}
          </div>

          {doc.tipRows.length > 0 && (
            <>
              <hr className="dashed" />
              <div className="tip">
                {doc.tipRows.map((row, i) => (
                  <div className="row" key={i}>
                    <span>{row.label}</span>
                    <span className="right">{row.amount}</span>
                  </div>
                ))}
                {doc.tipNotice && <p className="tip-notice">{doc.tipNotice}</p>}
              </div>
            </>
          )}

          {doc.footerLines.length > 0 && (
            <>
              <hr className="dashed" />
              <div className="footer">
                {doc.footerLines.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            </>
          )}
        </article>
      </div>
    </>
  );
}

// Estilos inline (no via Tailwind) — la tirilla necesita un look muy
// específico sin contaminación del CSS global de la app, y el `@media
// print` tiene que ganarle al shell del panel.
const POS_STYLES = `
  .precuenta-shell {
    min-height: 100%;
    background: #f1f1f1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 24px 12px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: #000;
  }
  .precuenta-shell *, .precuenta-shell *::before, .precuenta-shell *::after { box-sizing: border-box; }
  .precuenta-controls {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-bottom: 16px;
  }
  .precuenta-controls button, .precuenta-controls a {
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
  .precuenta-controls button:disabled { opacity: 0.6; cursor: default; }
  .precuenta-controls a.secondary { background: #fff; color: #000; }
  .precuenta-controls .print-note {
    flex-basis: 100%;
    text-align: center;
    font-size: 11px;
    color: #1e5339;
  }
  .precuenta-controls .print-note.warn { color: #8f6828; }
  .precuenta-controls .print-note.error { color: #b3261e; }
  /* El recibo mide LO MISMO en pantalla que en papel (ancho y relleno):
     la página que se pide al imprimir sale de medirlo en pantalla. */
  .receipt {
    background: #fff;
    color: #000;
    max-width: 100%;
    padding: 3mm 4mm 2mm;
    font-size: 12px;
    line-height: 1.25;
    box-shadow: 0 6px 24px rgba(0,0,0,0.08);
  }
  .receipt .biz-name {
    text-align: center;
    font-weight: 700;
    font-size: 13px;
    text-transform: uppercase;
  }
  .receipt .meta { text-align: center; font-size: 10px; line-height: 1.2; }
  .receipt hr.dashed { border: none; border-top: 1px dashed #000; margin: 3px 0; }
  .receipt .title {
    text-align: center;
    font-weight: 700;
    font-size: 16px;
    letter-spacing: 0.08em;
  }
  .receipt .not-invoice { text-align: center; font-size: 10px; }
  .receipt .meta-rows {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    column-gap: 8px;
  }
  /* Dos datos por fila; si no entran, el de la derecha baja entero. */
  .receipt .row {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    column-gap: 6px;
  }
  .receipt .row .right { margin-left: auto; white-space: nowrap; text-align: right; }
  .receipt .items .line {
    padding-left: 3ch;
    text-indent: -3ch;
    overflow-wrap: anywhere;
  }
  .receipt .items .line .qty { display: inline-block; min-width: 2ch; text-indent: 0; }
  .receipt .items .amount {
    float: right;
    margin-left: 6px;
    white-space: nowrap;
    text-indent: 0;
  }
  .receipt .hung {
    font-size: 9px;
    line-height: 1.2;
    padding-left: 3ch;
    overflow-wrap: anywhere;
  }
  .receipt .totals .grand {
    font-weight: 700;
    font-size: 14px;
    margin-top: 2px;
    padding-top: 2px;
    border-top: 1px solid #000;
  }
  .receipt .tip-notice { font-size: 9px; line-height: 1.25; margin: 2px 0 0; }
  .receipt .footer { text-align: center; font-size: 11px; line-height: 1.25; }
  @media print {
    header, nav, aside, footer, [role="navigation"], .no-print { display: none !important; }
    body { background: #fff !important; }
    .precuenta-shell { background: #fff; padding: 0; min-height: 0; display: block; }
    .receipt { box-shadow: none; }
    /* Sin márgenes: el relleno del recibo ya deja el borde que la
       térmica no imprime. El alto lo pone fitPageToContent al imprimir. */
    @page { margin: 0; }
  }
`;
