import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import type { SalesTaxKind } from "@/lib/salesTax";
import { SalesTaxConfigEditor } from "@/components/SalesTaxConfigEditor";

export const dynamic = "force-dynamic";

/**
 * Configuración → Impuestos: el impuesto de ventas del comercio
 * (impoconsumo / IVA / ninguno + tarifa).
 *
 * Vivía dentro de la tarjeta "Impuestos" de la pestaña PYG de
 * Contabilidad, detrás del módulo `accounting`. El dueño lo buscó tres
 * veces sin encontrarlo, y antes de eso su restaurante facturó a la DIAN
 * con impuesto en cero sin que nadie lo notara. Un dato fiscal del
 * comercio no es un renglón del estado de resultados: va con el resto de
 * la configuración del negocio, al lado de Facturación DIAN, que es la
 * pantalla que lo consume.
 *
 * Sin gate de módulo: lo necesita todo comercio que facture.
 */
export default async function ImpuestosPage() {
  const t = await getTranslations("opSalesTax");
  const tErp = await getTranslations("opErp");
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return <div className="p-6">{tSettings("noRestaurant")}</div>;
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { salesTaxKind: true, salesTaxPct: true },
  });
  if (!tenant) {
    return <div className="p-6">{tSettings("restaurantNotFound")}</div>;
  }

  return (
    <div className="p-6 max-w-2xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
      >
        {tSettings("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">{t("title")}</div>
      <p className="text-sm text-op-muted mb-6">{t("intro")}</p>

      <div className="space-y-6">
        <SalesTaxConfigEditor
          initial={{
            kind: tenant.salesTaxKind as SalesTaxKind,
            pct: tenant.salesTaxPct,
          }}
        />

        {/* El aviso va pegado al editor, no al final: es lo que hay que
            leer ANTES de tocar el selector. Y dice la verdad del código:
            los platos del menú no congelan la tarifa, la factura la lee
            del comercio al emitirse — una cuenta abierta ayer se factura
            hoy con el impuesto de hoy. */}
        <div
          className="rounded-xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 p-3 text-sm text-[#8F6828]"
          role="note"
        >
          {t("changeWarning")}
        </div>

        <section className="rounded-2xl border border-op-border bg-op-surface p-5">
          <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-2">
            {t("whatKicker")}
          </div>
          <p className="text-sm">{t("whatBody")}</p>
        </section>

        <section className="rounded-2xl border border-op-border bg-op-surface p-5">
          <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-3">
            {t("optionsKicker")}
          </div>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm font-medium">{tErp("taxKindInc")}</dt>
              <dd className="text-xs text-op-muted">{t("optionInc")}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium">{tErp("taxKindIva")}</dt>
              <dd className="text-xs text-op-muted">{t("optionIva")}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium">{tErp("taxConfigNone")}</dt>
              <dd className="text-xs text-op-muted">{t("optionNone")}</dd>
            </div>
          </dl>
          <p className="text-xs text-op-muted mt-4">{t("askAccountant")}</p>
        </section>

        <Link
          href="/operator/settings/facturacion-dian"
          className="inline-block text-xs text-terracotta underline"
        >
          {t("dianLink")}
        </Link>
      </div>
    </div>
  );
}
