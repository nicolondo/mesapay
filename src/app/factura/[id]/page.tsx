import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import {
  formatInvoiceNumber,
  type InvoiceSnapshot,
} from "@/lib/invoice";
import { restaurantLogoSrc } from "@/lib/branding";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const inv = await db.simpleInvoice.findUnique({
    where: { id },
    select: {
      invoiceNumber: true,
      snapshot: true,
    },
  });
  if (!inv) return { title: "Factura — MESAPAY" };
  const snap = inv.snapshot as unknown as InvoiceSnapshot;
  const num = formatInvoiceNumber(snap, inv.invoiceNumber);
  const name = snap.legalName ?? snap.restaurantName;
  return { title: `${num} · ${name}`, robots: { index: false, follow: false } };
}

/**
 * Página pública de la factura simple — estilo tirilla POS. Diseño:
 * fondo blanco, letras negras, ancho 80mm (~302px) con @media print
 * configurando @page para impresión limpia en térmicas o A4.
 *
 * No requiere auth — el cuid del id es la barrera (no enumerable).
 * El root layout sigue envolviendo la página; usamos un `<style>`
 * inline para resetear paddings y forzar el aspecto POS sin depender
 * del CSS global de la app.
 */
export default async function FacturaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const inv = await db.simpleInvoice.findUnique({
    where: { id },
    include: { order: { select: { shortCode: true } } },
  });
  if (!inv) return notFound();

  const snap = inv.snapshot as unknown as InvoiceSnapshot;
  const invNumber = formatInvoiceNumber(snap, inv.invoiceNumber);
  const paidAt = new Date(snap.paidAtIso);
  const dianDate = snap.dianResolutionDate
    ? new Date(snap.dianResolutionDate)
    : null;

  return (
    <>
      <style>{POS_STYLES}</style>
      <div className="factura-shell">
        <div className="factura-controls">
          <PrintButton />
          <a href="/" className="secondary">
            MESAPAY
          </a>
        </div>

        <article className="receipt">
          <img
            className="logo"
            src={restaurantLogoSrc(snap.logoUrl)}
            alt={snap.legalName ?? snap.restaurantName}
          />
          <div className="biz-name">
            {snap.legalName?.trim() || snap.restaurantName}
          </div>
          <div className="meta">
            {snap.taxId && (
              <>
                NIT {snap.taxId}
                <br />
              </>
            )}
            {snap.legalAddress && (
              <>
                {snap.legalAddress}
                <br />
              </>
            )}
            {snap.legalPhone && (
              <>
                {snap.legalPhone}
                <br />
              </>
            )}
          </div>

          <hr className="dashed" />

          <div className="row">
            <span>Comprobante</span>
            <span className="right">
              <strong>{invNumber}</strong>
            </span>
          </div>
          <div className="row">
            <span>Fecha</span>
            <span className="right">
              {paidAt.toLocaleString("es-CO", {
                dateStyle: "short",
                timeStyle: "short",
              })}
            </span>
          </div>
          <div className="row">
            <span>{snap.tableLabel}</span>
            <span className="right">{snap.shortCode}</span>
          </div>

          <hr className="dashed" />

          <div className="items">
            {snap.items.map((it, idx) => (
              <div className="line" key={idx}>
                <span className="qty">{it.qty}×</span>
                <span className="iname">{it.name}</span>
                <span className="amount">
                  {fmtCOP(it.qty * it.priceCents)}
                </span>
              </div>
            ))}
          </div>

          <hr className="dashed" />

          <div className="totals">
            <div className="row">
              <span>Subtotal</span>
              <span className="right">{fmtCOP(snap.subtotalCents)}</span>
            </div>
            {snap.tipCents > 0 && (
              <div className="row">
                <span>Propina</span>
                <span className="right">{fmtCOP(snap.tipCents)}</span>
              </div>
            )}
            <div className="row grand">
              <span>TOTAL</span>
              <span className="right">{fmtCOP(snap.totalCents)}</span>
            </div>
          </div>

          <hr className="dashed" />

          <div className="footer">
            {snap.dianResolution && (
              <>
                {snap.dianResolution}
                <br />
              </>
            )}
            {snap.dianResolutionFrom != null &&
              snap.dianResolutionTo != null && (
                <>
                  Numeración del {snap.dianResolutionFrom} al{" "}
                  {snap.dianResolutionTo}
                  <br />
                </>
              )}
            {dianDate && (
              <>
                Fecha de resolución {dianDate.toLocaleDateString("es-CO")}
                <br />
              </>
            )}
            <br />
            ¡Gracias por tu visita!
            <br />
            <span style={{ fontSize: "9px", opacity: 0.6 }}>
              Generado con MESAPAY
            </span>
          </div>
        </article>
      </div>
    </>
  );
}

// Botón cliente — necesita window.print(). Component server-side
// porque solo dispara un form action JS sin estado React.
function PrintButton() {
  return (
    <form
      action="javascript:window.print()"
      style={{ margin: 0 }}
    >
      <button type="submit">Imprimir</button>
    </form>
  );
}

// Estilos inline (no via Tailwind) — la tirilla necesita un look
// muy específico sin contaminación del CSS global de la app.
const POS_STYLES = `
  .factura-shell {
    min-height: 100vh;
    background: #f1f1f1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 24px 12px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: #000;
  }
  .factura-shell *, .factura-shell *::before, .factura-shell *::after { box-sizing: border-box; }
  .factura-controls {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin-bottom: 16px;
  }
  .factura-controls button, .factura-controls a {
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
  .factura-controls a.secondary {
    background: #fff;
    color: #000;
  }
  .receipt {
    background: #fff;
    color: #000;
    width: 80mm;
    max-width: 100%;
    padding: 18px 14px;
    font-size: 12px;
    line-height: 1.45;
    box-shadow: 0 6px 24px rgba(0,0,0,0.08);
  }
  .receipt .logo {
    display: block;
    margin: 0 auto 8px auto;
    max-width: 64px;
    max-height: 64px;
    object-fit: contain;
  }
  .receipt .biz-name {
    text-align: center;
    font-weight: 700;
    font-size: 14px;
    margin: 4px 0 2px 0;
    text-transform: uppercase;
  }
  .receipt .meta { text-align: center; font-size: 11px; line-height: 1.4; }
  .receipt hr.dashed {
    border: none;
    border-top: 1px dashed #000;
    margin: 10px 0;
  }
  .receipt .row { display: flex; justify-content: space-between; gap: 8px; }
  .receipt .row .right { white-space: nowrap; }
  .receipt .items { font-size: 12px; }
  .receipt .items .line {
    display: grid;
    grid-template-columns: 28px 1fr auto;
    column-gap: 6px;
    margin-bottom: 4px;
  }
  .receipt .items .qty { text-align: right; }
  .receipt .items .iname { text-align: left; font-size: 12px; }
  .receipt .items .amount { white-space: nowrap; text-align: right; }
  .receipt .totals { font-size: 12px; }
  .receipt .totals .row { padding: 2px 0; }
  .receipt .totals .grand {
    font-weight: 700;
    font-size: 14px;
    padding-top: 6px;
    margin-top: 6px;
    border-top: 1px solid #000;
  }
  .receipt .footer {
    text-align: center;
    font-size: 10px;
    margin-top: 12px;
    line-height: 1.5;
  }
  @media print {
    body { background: #fff !important; }
    .factura-shell { background: #fff; padding: 0; min-height: 0; }
    .factura-controls { display: none; }
    .receipt { box-shadow: none; padding: 0; }
    @page { margin: 8mm; }
  }
`;
