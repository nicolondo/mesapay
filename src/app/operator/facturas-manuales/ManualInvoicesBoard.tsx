"use client";

import { displayOrderCode } from "@/lib/orderCode";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";
import type { CompPolicyView } from "@/lib/staffPolicies";
import type { RestaurantTax } from "@/lib/salesTax";
import type { ManualInvoiceSendInfo } from "@/components/manualInvoice/types";
import { TableDetailSheet } from "../tables/TableDetailSheet";
import type { ActiveOrder } from "../tables/MesasGrid";

/**
 * FACTURAS MANUALES PENDIENTES — la casa de las facturas manuales que
 * todavía se están armando (borrador) o que se enviaron sólo con el link
 * de pago. El dueño: «no quiero que las facturas manuales queden en la
 * pantalla de Mesas hasta que quede pagada»: una factura manual no es una
 * mesa. Se crea acá (o desde Mesas / Nueva orden, que traen acá), se edita
 * en la misma ficha de siempre (`TableDetailSheet` en modo `manual`) y, al
 * emitirla o cobrarla, sale de esta lista (queda en Órdenes y, por cobrar,
 * en Cartera).
 */
export type ManualInvoiceTileData = {
  id: string;
  number: number;
  qrToken: string;
  order: ActiveOrder;
  /** "Emitir y enviar factura" (src/lib/manualInvoiceSendInfo.ts). */
  sendInfo: ManualInvoiceSendInfo;
};

export function ManualInvoicesBoard({
  tiles,
  initialOpenTileId = null,
  tenantSlug,
  country,
  salesTax,
  chargeLocked,
  moveLocked,
  compPolicy,
  viewerRole,
}: {
  tiles: ManualInvoiceTileData[];
  /** `?open=<tableId>`: la ficha que abre al cargar (la recién creada). */
  initialOpenTileId?: string | null;
  tenantSlug: string;
  country: string | null;
  salesTax: RestaurantTax | null;
  chargeLocked: boolean;
  moveLocked: boolean;
  compPolicy: CompPolicyView;
  viewerRole: string | null;
}) {
  const tm = useTranslations("manualInvoices");
  const tr = useTranslations("opTables");
  const router = useRouter();
  const [openTileId, setOpenTileId] = useState<string | null>(initialOpenTileId);
  const [opening, setOpening] = useState(false);

  /** Abre una factura manual nueva y despliega su ficha al volver el refresh. */
  async function createManualInvoice() {
    setOpening(true);
    try {
      const res = await fetch("/api/operator/manual-invoices", { method: "POST" });
      if (!res.ok) {
        window.alert(tr("manualInvoiceOpenFailed"));
        return;
      }
      const j = (await res.json()) as { tableId: string };
      setOpenTileId(j.tableId);
      router.refresh();
    } catch {
      window.alert(tr("manualInvoiceOpenFailed"));
    } finally {
      setOpening(false);
    }
  }

  return (
    <section aria-label={tm("pendingTitle")}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">{tm("pendingTitle")}</h2>
          <p className="text-[11px] text-op-muted mt-0.5">{tm("pendingHint")}</p>
        </div>
        <button
          type="button"
          onClick={createManualInvoice}
          disabled={opening}
          className="h-9 px-4 inline-flex items-center gap-1 rounded-full text-sm font-medium bg-terracotta text-bone hover:brightness-95 disabled:opacity-60"
        >
          <span aria-hidden>{"+"}</span>
          <span>{opening ? tr("manualInvoiceOpening") : tm("newButton")}</span>
        </button>
      </div>
      {tiles.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-op-border bg-op-surface p-6 text-center text-sm text-op-muted">
          {tm("pendingEmpty")}
        </p>
      ) : (
        <div className="mp-table-grid">
          {tiles.map((tile) => (
            <ManualInvoiceTile
              key={tile.id}
              tile={tile}
              open={openTileId === tile.id}
              onOpenChange={(next) => setOpenTileId(next ? tile.id : null)}
              tenantSlug={tenantSlug}
              country={country}
              salesTax={salesTax}
              chargeLocked={chargeLocked}
              moveLocked={moveLocked}
              compPolicy={compPolicy}
              viewerRole={viewerRole}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Tile de una factura manual abierta — código, lo que falta por cobrar y
 * el cliente (si se identificó) o la cantidad de ítems. Sin walkout-risk
 * ni estado de cocina: nada se prepara ni se entrega. Tap abre la misma
 * ficha que una mesa, en modo `manual`.
 */
export function ManualInvoiceTile({
  tile,
  open,
  onOpenChange,
  tenantSlug,
  country,
  salesTax,
  chargeLocked,
  moveLocked,
  compPolicy,
  viewerRole,
}: {
  tile: ManualInvoiceTileData;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  tenantSlug: string;
  country: string | null;
  salesTax: RestaurantTax | null;
  chargeLocked: boolean;
  moveLocked: boolean;
  compPolicy: CompPolicyView;
  viewerRole: string | null;
}) {
  const tr = useTranslations("opTables");
  const tm = useTranslations("manualInvoices");
  // El cliente de la factura (si ya se identificó) es lo que distingue una
  // factura manual de otra en la grilla.
  const who =
    tile.order.invoiceRequest?.customerName ??
    tile.order.customer?.name ??
    (tile.order.itemCount > 0
      ? tr("tileMetaItems", { count: tile.order.itemCount })
      : tr("manualTileEmpty"));
  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="aspect-[4/3] rounded-xl border border-terracotta/40 bg-terracotta/5 hover:bg-terracotta/10 p-2 flex flex-col items-center justify-center text-center transition-colors relative"
      >
        <div className="font-mono text-[9px] tracking-wider uppercase text-terracotta-2">
          {tr("manualInvoiceLabel")}
        </div>
        <div className="font-mono text-[10px] text-op-muted truncate w-full mt-0.5" title={tile.order.shortCode}>
          {displayOrderCode(tile.order.shortCode)}
        </div>
        <div className="font-mono text-[12px] tabular leading-tight mt-1">
          {fmtCOP(tile.order.outstandingCents)}
        </div>
        <div className="font-mono text-[9px] text-op-muted mt-0.5 truncate w-full">
          {who}
        </div>
        <span
          className={
            "mt-1 font-mono text-[9px] tracking-wider uppercase px-1.5 py-0.5 rounded-full " +
            (tile.sendInfo.link ? "bg-[#C9A227]/15 text-[#7A5E0A]" : "bg-op-bg text-op-muted")
          }
        >
          {tile.sendInfo.link ? tm("stateSent") : tm("stateDraft")}
        </span>
      </button>

      {open && (
        <TableDetailSheet
          manual
          orderId={tile.order.id}
          shortCode={tile.order.shortCode}
          tableLabel={tr("manualInvoiceLabel")}
          tableNumber={tile.number}
          tableId={tile.id}
          // Una factura manual no se mueve ni recibe platos de una mesa:
          // sin destinos, la ficha no ofrece "Mover".
          freeTables={[]}
          allTables={[]}
          initialRounds={tile.order.rounds}
          open={open}
          onOpenChange={onOpenChange}
          hideTrigger
          orderStatus={tile.order.status}
          outstandingCents={tile.order.outstandingCents}
          subtotalCents={tile.order.subtotalCents}
          grossSubtotalCents={tile.order.grossSubtotalCents}
          discountCents={tile.order.discountCents}
          discountPct={tile.order.discountPct}
          customer={tile.order.customer}
          invoiceRequest={tile.order.invoiceRequest}
          invoiceIntent={tile.order.invoiceIntent}
          invoice={tile.order.invoice}
          pendingPayments={tile.order.pendingPayments}
          terminalAmounts={tile.order.terminalAmounts}
          sendInfo={tile.sendInfo}
          tenantSlug={tenantSlug}
          qrToken={tile.qrToken}
          isMeseroView={false}
          country={country}
          salesTax={salesTax}
          chargeLocked={chargeLocked}
          moveLocked={moveLocked}
          compPolicy={compPolicy}
          viewerRole={viewerRole}
        />
      )}
    </>
  );
}

