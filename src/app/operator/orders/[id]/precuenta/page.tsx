import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { loadPrebill } from "@/lib/print/prebillData";
import { buildPrebillDocument } from "@/lib/print/prebillQueue";
import { PrintButton } from "@/app/factura/[id]/PrintButton";

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
 * ESC/POS) y acá sólo se dibuja como tirilla estrecha. Estilo POS inline
 * como `/factura/[id]`: fondo blanco, monoespaciada, ancho del papel del
 * comercio, y `@media print` que esconde el chrome del panel (o del PWA
 * del mesero, que re-exporta esta página) y deja sólo el papel.
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
  const backHref =
    session?.user?.role === "mesero" ? "/mesero/mesas" : "/operator/tables";

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
  const paperMm = Math.min(80, Math.max(58, loaded.paperWidthMm));

  return (
    <>
      <style>{POS_STYLES}</style>
      <div className="precuenta-shell">
        <div className="precuenta-controls no-print">
          <PrintButton autoPrint={print === "1"} />
          <Link href={backHref} className="secondary">
            {tr("prebillBack")}
          </Link>
        </div>

        <article className="receipt" style={{ width: `${paperMm}mm` }}>
          <div className="biz-name">{doc.businessName}</div>
          {doc.businessLines.length > 0 && (
            <div className="meta">
              {doc.businessLines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          )}

          <hr className="dashed" />

          <div className="title">{doc.title}</div>
          <div className="not-invoice">{doc.notInvoiceLine}</div>

          <hr className="dashed" />

          {doc.metaRows.map((row, i) => (
            <div className="row" key={i}>
              <span>{row.label}</span>
              <span className="right">{row.value}</span>
            </div>
          ))}

          <hr className="dashed" />

          <div className="items">
            {doc.items.map((it, i) => (
              <div className="item" key={i}>
                <div className="line">
                  <span className="qty">{tr("prebillQty", { qty: it.qty })}</span>
                  <span className="iname">{it.name}</span>
                  <span className="amount">{it.amount}</span>
                </div>
                {it.unit && (
                  <div className="hung">
                    {tr("prebillQtyUnit", { qty: it.qty, unit: it.unit })}
                  </div>
                )}
                {it.modifiers.map((m, j) => (
                  <div className="hung" key={j}>
                    - {m}
                  </div>
                ))}
                {it.notes && <div className="hung">&quot;{it.notes}&quot;</div>}
              </div>
            ))}
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
  .precuenta-controls a.secondary { background: #fff; color: #000; }
  .receipt {
    background: #fff;
    color: #000;
    max-width: 100%;
    padding: 18px 14px;
    font-size: 12px;
    line-height: 1.45;
    box-shadow: 0 6px 24px rgba(0,0,0,0.08);
  }
  .receipt .biz-name {
    text-align: center;
    font-weight: 700;
    font-size: 14px;
    margin: 4px 0 2px 0;
    text-transform: uppercase;
  }
  .receipt .meta { text-align: center; font-size: 11px; line-height: 1.4; }
  .receipt hr.dashed { border: none; border-top: 1px dashed #000; margin: 10px 0; }
  .receipt .title {
    text-align: center;
    font-weight: 700;
    font-size: 20px;
    letter-spacing: 0.08em;
  }
  .receipt .not-invoice { text-align: center; font-size: 11px; margin-top: 2px; }
  .receipt .row { display: flex; justify-content: space-between; gap: 8px; }
  .receipt .row .right { white-space: nowrap; text-align: right; }
  .receipt .items { font-size: 12px; }
  .receipt .item { margin-bottom: 4px; }
  .receipt .items .line {
    display: grid;
    grid-template-columns: 28px 1fr auto;
    column-gap: 6px;
  }
  .receipt .items .qty { text-align: right; }
  .receipt .items .amount { white-space: nowrap; text-align: right; }
  .receipt .hung { font-size: 10px; padding-left: 34px; opacity: 0.85; }
  .receipt .totals { font-size: 12px; }
  .receipt .totals .row { padding: 2px 0; }
  .receipt .totals .grand {
    font-weight: 700;
    font-size: 14px;
    padding-top: 6px;
    margin-top: 6px;
    border-top: 1px solid #000;
  }
  .receipt .tip { font-size: 12px; }
  .receipt .tip .row { padding: 2px 0; }
  .receipt .tip-notice { font-size: 10px; line-height: 1.4; margin: 6px 0 0; }
  .receipt .footer { text-align: center; font-size: 11px; line-height: 1.5; }
  @media print {
    header, nav, aside, footer, [role="navigation"], .no-print { display: none !important; }
    body { background: #fff !important; }
    .precuenta-shell { background: #fff; padding: 0; min-height: 0; }
    .receipt { box-shadow: none; padding: 0; }
    @page { margin: 6mm; }
  }
`;
