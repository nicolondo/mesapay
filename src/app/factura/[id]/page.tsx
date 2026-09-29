import { displayOrderCode } from "@/lib/orderCode";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import QRCode from "qrcode";
import { getTranslations, getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { fmtCOP, formatDate, localeTag } from "@/lib/format";
import { type Locale } from "@/i18n/config";
import {
  formatInvoiceNumber,
  itemDetailText,
  taxLabelsFrom,
  taxRows,
  type InvoiceSnapshot,
} from "@/lib/invoice";
import { groupInvoiceLines } from "@/lib/invoiceLines";
import { isModuleEnabled } from "@/lib/modules";
import { dianQrUrl } from "@/lib/dian/crypto";
import { restaurantLogoSrc } from "@/lib/branding";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  invoicePrintHref,
  staffPrintAccessFor,
  type StaffPrintDoc,
} from "@/lib/print/staffPrint";
import { PrintButton } from "./PrintButton";

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
  if (!inv) {
    const t = await getTranslations("emailInvoice");
    return { title: t("metaTitleFallback"), manifest: null, appleWebApp: false };
  }
  const snap = inv.snapshot as unknown as InvoiceSnapshot;
  const num = formatInvoiceNumber(snap, inv.invoiceNumber);
  const name = snap.legalName ?? snap.restaurantName;
  return { title: `${num} · ${name}`, robots: { index: false, follow: false }, manifest: null, appleWebApp: false };
}

/**
 * Página pública de la factura simple — estilo tirilla POS: fondo blanco,
 * letras negras, del ANCHO DEL PAPEL del comercio (80 o 58 mm).
 *
 * No requiere auth — el cuid del id es la barrera (no enumerable).
 * El root layout sigue envolviendo la página; usamos un `<style>`
 * inline para resetear paddings y forzar el aspecto POS sin depender
 * del CSS global de la app.
 *
 * IMPRESIÓN. Es el respaldo de cuando el local no tiene impresora de
 * facturas en el agente (y lo que imprime el comensal en su casa). Dos
 * cosas para que no pase lo de la foto del dueño —una factura larga en DOS
 * tiras, con aire por todos lados—:
 *
 *  - una sola página del alto del documento (`fitPageToContent`, desde el
 *    botón, `?print=1`, Ctrl+P o el iframe oculto de la reimpresión). Por
 *    eso el recibo mide lo mismo en pantalla que en papel: mismo ancho,
 *    mismo relleno; al imprimir sólo se va el decorado (sombra, fondo);
 *  - formato COMPACTO, el mismo del ESC/POS: datos del comercio en un
 *    párrafo, número y fecha en una fila, el precio del plato flotando a
 *    la derecha del PRIMER renglón (el nombre usa todo el ancho), y
 *    modificadores y nota en un renglón chico.
 *
 * Cuando la mira el STAFF del comercio, "Imprimir" manda la factura al
 * agente, como las comandas (ver `PrintButton`).
 */
export default async function FacturaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ print?: string }>;
}) {
  const { id } = await params;
  const { print } = await searchParams;
  const t = await getTranslations("emailInvoice");
  const locale = (await getLocale()) as Locale;
  const tag = localeTag(locale);
  const inv = await db.simpleInvoice.findUnique({
    where: { id },
    include: {
      order: { select: { shortCode: true } },
      dianDocument: { select: { state: true, cufe: true } },
      restaurant: {
        select: {
          enabledModules: true,
          printPaperWidthMm: true,
          dianConfig: { select: { environment: true } },
          legalEntity: {
            select: { dianConfig: { select: { environment: true } } },
          },
        },
      },
    },
  });
  if (!inv) return notFound();

  const snap = inv.snapshot as unknown as InvoiceSnapshot;
  const invNumber = formatInvoiceNumber(snap, inv.invoiceNumber);
  const paidAt = new Date(snap.paidAtIso);
  const dianDate = snap.dianResolutionDate
    ? new Date(snap.dianResolutionDate)
    : null;
  // El ancho del papel del comercio: el recibo mide eso en pantalla y en
  // papel, y la página que se pide al imprimir también.
  const paperMm = (inv.restaurant.printPaperWidthMm ?? 80) <= 58 ? 58 : 80;

  // ¿La mira el STAFF de este comercio? Entonces "Imprimir" va al agente.
  // Se decide acá, con la sesión: el comensal (sin sesión, o de otro
  // comercio) imprime la página y nada más.
  const session = await auth();
  const access = staffPrintAccessFor(session?.user?.role);
  const activeRestaurantId = access ? await getActiveRestaurantId() : null;
  const agentDoc: StaffPrintDoc | null =
    access && activeRestaurantId === inv.restaurantId
      ? {
          kind: "invoice",
          orderId: inv.orderId,
          href: invoicePrintHref({ invoiceId: inv.id }),
        }
      : null;

  // Bloque fiscal DIAN (CUFE + QR) — solo con el módulo `einvoicing`
  // activo y un documento electrónico ACEPTADO con CUFE. En cualquier
  // otro caso la tirilla se ve exactamente como hoy. El ambiente
  // (host del catálogo DIAN) sale de la config del emisor: gana el
  // LegalEntity del grupo si existe (mismo criterio que resolveEmisor),
  // y por defecto producción — es lo que ve un cliente con factura real.
  const einvoicingOn = isModuleEnabled(
    inv.restaurant.enabledModules,
    "einvoicing",
  );
  const dianCufe =
    einvoicingOn && inv.dianDocument?.state === "accepted"
      ? inv.dianDocument.cufe
      : null;
  const dianEnv =
    inv.restaurant.legalEntity?.dianConfig?.environment ??
    inv.restaurant.dianConfig?.environment ??
    "produccion";
  const dianQrDataUrl = dianCufe
    ? await QRCode.toDataURL(
        dianQrUrl(dianCufe, dianEnv === "produccion" ? "1" : "2"),
        { margin: 0, width: 220, errorCorrectionLevel: "M" },
      )
    : null;
  const einvoice = !!(dianCufe && dianQrDataUrl);

  // NIT · dirección · ciudad · teléfono, corridos en un párrafo.
  const bizMeta = [
    snap.taxId ? t("taxId", { id: snap.taxId }) : null,
    snap.legalAddress,
    snap.legalCity,
    snap.legalPhone ? t("phone", { phone: snap.legalPhone }) : null,
  ].filter((l): l is string => !!l && l.trim().length > 0);

  // Resolución DIAN (número, rango y fecha) en UN párrafo.
  const resolution = [
    snap.dianResolution
      ? t("dianResolution", { res: snap.dianResolution })
      : null,
    snap.dianResolutionFrom != null && snap.dianResolutionTo != null
      ? t("dianNumbering", {
          from: snap.dianResolutionFrom,
          to: snap.dianResolutionTo,
        })
      : null,
    dianDate
      ? t("dianDate", { date: dianDate.toLocaleDateString(tag) })
      : null,
  ].filter((l): l is string => !!l);

  const customerWhere = snap.customer
    ? [snap.customer.address, snap.customer.city].filter(Boolean).join(", ")
    : "";

  return (
    <>
      <style>{POS_STYLES}</style>
      <div className="factura-shell">
        <div className="factura-controls">
          <PrintButton autoPrint={print === "1"} agent={agentDoc} />
          <Link href="/" className="secondary">
            {"MESAPAY"}
          </Link>
        </div>

        <article
          className="receipt"
          data-print-document="factura"
          data-print-width-mm={paperMm}
          style={{ width: `${paperMm}mm`, paddingInline: `${paperMm === 80 ? 4 : 5}mm` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="logo"
            src={restaurantLogoSrc(snap.logoUrl)}
            alt={snap.legalName ?? snap.restaurantName}
          />
          <div className="biz-name">
            {snap.legalName?.trim() || snap.restaurantName}
          </div>
          {bizMeta.length > 0 && (
            <div className="meta">{bizMeta.join(" · ")}</div>
          )}

          <hr className="dashed" />

          {/* El rótulo solo (con la factura electrónica ACEPTADA, el legal:
              "Factura electrónica de venta"); debajo, número y fecha en una
              fila, y mesa y cliente en otra. Sin datos del adquiriente, la
              electrónica dice "Consumidor final", como el XML que viajó a
              la DIAN. */}
          <div className="doc-label">
            {einvoice ? t("dianFiscalTitle") : t("receiptLabel")}
          </div>
          <div className="row">
            <span>
              <strong>{invNumber}</strong>
            </span>
            <span className="right">
              {formatDate(paidAt, {
                locale,
                dateStyle: "short",
                timeStyle: "short",
              })}
            </span>
          </div>
          <div className="row">
            <span>
              {snap.tableLabel + " · "}
              <span title={snap.shortCode}>{displayOrderCode(snap.shortCode)}</span>
            </span>
            {!snap.customer && einvoice && (
              <span className="right">
                {t("customerLabel") + ": " + t("finalConsumer")}
              </span>
            )}
          </div>
          {snap.customer && (
            <>
              <div className="row">
                <span>{t("customerLabel") + ": " + snap.customer.name}</span>
                <span className="right">
                  {snap.customer.docType + " " + snap.customer.docNumber}
                </span>
              </div>
              {customerWhere && <div className="small">{customerWhere}</div>}
            </>
          )}

          <hr className="dashed" />

          {/* Repetidos AGRUPADOS ("2× Bretaña", src/lib/invoiceLines.ts).
              El precio FLOTA a la derecha del primer renglón: si el nombre
              no entra, sigue abajo con todo el ancho, sin reservar la
              columna del precio. Modificadores y nota, en un renglón chico. */}
          <div className="items">
            {groupInvoiceLines(snap.items).map((it, idx) => {
              const detail = itemDetailText(it);
              return (
                <div className="item" key={idx}>
                  <div className="line">
                    <span className="amount">{fmtCOP(it.totalCents)}</span>
                    <span className="qty">{it.qty + "×"}</span>
                    {" " + it.name}
                  </div>
                  {detail && <div className="idetail">{detail}</div>}
                </div>
              );
            })}
          </div>

          <hr className="dashed" />

          <div className="totals">
            <div className="row">
              <span>{t("subtotal")}</span>
              <span className="right">{fmtCOP(snap.subtotalCents)}</span>
            </div>
            {/* Primero el impuesto EMBEBIDO en los platos (base gravable +
                "Incl. impoconsumo 8%", informativo: ya está dentro del
                subtotal) tal como quedó congelado en la factura; después el
                que suman encima las líneas libres (servicios, alquileres).
                Sin ninguno de los dos no hay filas. */}
            {taxRows(snap, taxLabelsFrom(t)).map((r) => (
              <div className="row" key={r.label}>
                <span>{r.label}</span>
                <span className="right">{fmtCOP(r.cents)}</span>
              </div>
            ))}
            {/* Descuento del comensal identificado. Las facturas emitidas
                antes de esta feature no traen el campo — se trata como 0 y
                la tirilla se ve exactamente como antes. */}
            {(snap.discountCents ?? 0) > 0 && (
              <div className="row">
                <span>
                  {snap.discountPct
                    ? t("discountRowPct", { pct: snap.discountPct })
                    : t("discountRow")}
                </span>
                <span className="right">
                  {"− " + fmtCOP(snap.discountCents ?? 0)}
                </span>
              </div>
            )}
            {snap.tipCents > 0 && (
              <div className="row">
                <span>{t("tip")}</span>
                <span className="right">{fmtCOP(snap.tipCents)}</span>
              </div>
            )}
            <div className="row grand">
              <span>{t("total")}</span>
              <span className="right">{fmtCOP(snap.totalCents)}</span>
            </div>
          </div>

          {einvoice && (
            <>
              <hr className="dashed" />
              <div className="dian-fiscal">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="dian-qr"
                  src={dianQrDataUrl!}
                  alt={t("dianQrAlt")}
                />
                <div className="dian-cufe">
                  <strong>{t("dianCufeLabel") + ": "}</strong>
                  {dianCufe}
                </div>
                <div className="small">{t("einvoiceRepresentation")}</div>
              </div>
            </>
          )}

          <hr className="dashed" />

          <div className="footer">
            {resolution.length > 0 && <div>{resolution.join(" · ")}</div>}
            <section className="tip-notice" aria-label={t("tipNoticeTitle")}>
              <strong>{t("tipNoticeTitle")}</strong>
              {" " + t("tipNoticeBody")}
            </section>
            <div className="thanks">{t("thanks")}</div>
            {/* El dominio en letra un poco menos tenue que el resto: en una
                térmica, 9px al 60% se pierde, y es justamente lo que
                alguien podría querer teclear. */}
            <div className="generated">
              {t("generatedBy") + " · "}
              <span className="domain">{t("generatedByUrl")}</span>
            </div>
          </div>
        </article>
      </div>
    </>
  );
}

// Estilos inline (no via Tailwind) — la tirilla necesita un look
// muy específico sin contaminación del CSS global de la app.
//
// El recibo mide LO MISMO en pantalla que en papel (ancho y relleno): la
// página que se pide al imprimir se calcula midiéndolo en pantalla
// (`fitPageToContent`). Al imprimir sólo cambia el decorado.
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
    flex-wrap: wrap;
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
  .factura-controls button:disabled { opacity: 0.6; cursor: default; }
  .factura-controls a.secondary {
    background: #fff;
    color: #000;
  }
  .factura-controls .print-note {
    flex-basis: 100%;
    text-align: center;
    font-size: 11px;
    color: #1e5339;
  }
  .factura-controls .print-note.warn { color: #8f6828; }
  .factura-controls .print-note.error { color: #b3261e; }
  .receipt {
    background: #fff;
    color: #000;
    max-width: 100%;
    padding: 3mm 4mm 2mm;
    font-size: 12px;
    line-height: 1.25;
    box-shadow: 0 6px 24px rgba(0,0,0,0.08);
  }
  .receipt .logo {
    display: block;
    margin: 0 auto 2px auto;
    height: 36px;
    width: auto;
    max-width: 60%;
    object-fit: contain;
  }
  .receipt .biz-name {
    text-align: center;
    font-weight: 700;
    font-size: 13px;
    text-transform: uppercase;
  }
  .receipt .meta { text-align: center; font-size: 10px; line-height: 1.2; }
  .receipt hr.dashed {
    border: none;
    border-top: 1px dashed #000;
    margin: 3px 0;
  }
  .receipt .doc-label {
    text-align: center;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  /* Dos datos por fila; si no entran, el de la derecha baja entero. */
  .receipt .row {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    column-gap: 6px;
  }
  .receipt .row .right { margin-left: auto; white-space: nowrap; text-align: right; }
  .receipt .small { font-size: 9px; line-height: 1.2; }
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
  .receipt .items .idetail {
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
  .receipt .dian-fiscal { text-align: center; }
  .receipt .dian-fiscal .dian-qr {
    display: block;
    margin: 2px auto;
    width: 28mm;
    height: 28mm;
    image-rendering: pixelated;
  }
  .receipt .dian-fiscal .dian-cufe {
    font-size: 8px;
    line-height: 1.25;
    word-break: break-all;
  }
  .receipt .footer {
    text-align: center;
    font-size: 9px;
    line-height: 1.25;
  }
  .receipt .footer .tip-notice {
    margin: 2px 0;
    text-align: left;
    break-inside: avoid;
    overflow-wrap: break-word;
  }
  .receipt .footer .thanks { font-size: 11px; }
  .receipt .footer .generated { opacity: 0.6; }
  .receipt .footer .generated .domain { opacity: 1; font-weight: 700; }
  @media print {
    body { background: #fff !important; }
    .factura-shell { background: #fff; padding: 0; min-height: 0; display: block; }
    .factura-controls { display: none; }
    .receipt { box-shadow: none; }
    /* Sin márgenes: el relleno del recibo ya deja el borde que la
       térmica no imprime. El alto lo pone fitPageToContent al imprimir. */
    @page { margin: 0; }
  }
`;
