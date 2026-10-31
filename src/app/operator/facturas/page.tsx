import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { isModuleEnabled } from "@/lib/modules";
import { pendingEmissionSummary } from "@/lib/dian/pendingEmission";
import { parseInvoiceListParams } from "@/lib/dian/invoiceList";
import {
  countRecentRejected,
  loadInvoiceListPage,
  loadLateInvoiceRequests,
} from "@/lib/dian/invoiceListQueries";
import { FacturasClient } from "./FacturasClient";
import { ElectronicInvoicesClient } from "./ElectronicInvoicesClient";

export const dynamic = "force-dynamic";

// /operator/facturas tiene dos caras según el módulo `einvoicing`:
//
//   · SIN el módulo: las solicitudes de factura de los clientes (flujo
//     manual — el comercio emite desde su propio sistema y marca la
//     solicitud). Exactamente como siempre; lo fija page.test.ts.
//   · CON el módulo: MESAPAY emite sola a la DIAN, así que marcar
//     solicitudes ya no tiene sentido. La pantalla lista las FACTURAS
//     ELECTRÓNICAS del comercio con su estado DIAN, el correo y la nota
//     crédito, y avisa lo que pide a alguien: la emisión frenada, las
//     rechazadas y los clientes que pidieron factura cuando la cuenta ya
//     había salido a consumidor final.

// Sólo lo que muestran las tarjetas del flujo manual; la tirilla habilita
// "Imprimir en datáfono".
const manualOrderInclude = {
  select: {
    shortCode: true,
    totalCents: true,
    paidAt: true,
    simpleInvoice: { select: { id: true } },
  },
} as const;

export default async function FacturasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("opFacturas");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const [sp, restaurant] = await Promise.all([
    searchParams,
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { enabledModules: true, businessDayCutoffHour: true },
    }),
  ]);

  if (isModuleEnabled(restaurant?.enabledModules, "einvoicing")) {
    const cutoffHour = restaurant?.businessDayCutoffHour ?? 0;
    const params = parseInvoiceListParams(sp);
    const [list, emission, rejected, late] = await Promise.all([
      loadInvoiceListPage(restaurantId, params, cutoffHour),
      // Con emisión automática, una configuración incompleta frena TODAS
      // las facturas del comercio en silencio: el resumen lo hace visible.
      pendingEmissionSummary(restaurantId),
      countRecentRejected(restaurantId, cutoffHour),
      loadLateInvoiceRequests(restaurantId),
    ]);
    return (
      <ElectronicInvoicesClient
        params={params}
        cutoffHour={cutoffHour}
        list={list}
        emission={emission}
        rejected={rejected}
        late={late}
      />
    );
  }

  const tab = sp.status === "generated" ? "generated" : "pending";
  const [pending, generated] = await Promise.all([
    db.invoiceRequest.findMany({
      where: { restaurantId, status: "pending" },
      orderBy: { createdAt: "desc" },
      include: { order: manualOrderInclude },
    }),
    db.invoiceRequest.findMany({
      where: { restaurantId, status: "generated" },
      orderBy: { generatedAt: "desc" },
      take: 100,
      include: { order: manualOrderInclude },
    }),
  ]);

  return (
    <FacturasClient
      tab={tab}
      pending={pending.map((r) => ({
        id: r.id,
        customerName: r.customerName,
        docType: r.docType,
        docNumber: r.docNumber,
        address: r.address,
        city: r.city,
        department: r.department,
        email: r.email,
        notes: r.notes,
        createdAt: r.createdAt.toISOString(),
        order: {
          shortCode: r.order.shortCode,
          totalCents: r.order.totalCents,
          paidAt: r.order.paidAt?.toISOString() ?? null,
        },
        // Para "Imprimir en datáfono": presente si la tirilla ya se generó.
        simpleInvoiceId: r.order.simpleInvoice?.id ?? null,
      }))}
      generated={generated.map((r) => ({
        id: r.id,
        customerName: r.customerName,
        docType: r.docType,
        docNumber: r.docNumber,
        address: r.address,
        city: r.city,
        department: r.department,
        email: r.email,
        notes: r.notes,
        createdAt: r.createdAt.toISOString(),
        generatedAt: r.generatedAt?.toISOString() ?? null,
        generatedByEmail: r.generatedByEmail,
        order: {
          shortCode: r.order.shortCode,
          totalCents: r.order.totalCents,
          paidAt: r.order.paidAt?.toISOString() ?? null,
        },
        simpleInvoiceId: r.order.simpleInvoice?.id ?? null,
      }))}
    />
  );
}
