import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { isModuleEnabled } from "@/lib/modules";
import { resolveDianRecipient } from "@/lib/dian/invoiceEmail";
import { pendingEmissionSummary } from "@/lib/dian/pendingEmission";
import { FacturasClient } from "./FacturasClient";

export const dynamic = "force-dynamic";

// La emisión a la DIAN opera sobre la SimpleInvoice (tirilla ya generada
// por la orden), enlazada 1:1 al Order. La solicitud de factura formal
// (InvoiceRequest) comparte ese Order, así que traemos el DianDocument
// vía order.simpleInvoice. Con el módulo `einvoicing` apagado esto queda
// en null y la lista se ve exactamente como hoy.
const orderInclude = {
  select: {
    shortCode: true,
    totalCents: true,
    paidAt: true,
    // Las tres fuentes del destinatario de la factura electrónica, para
    // poder mostrar a qué correo saldría el reenvío ANTES de apretar el
    // botón. Mismo orden de precedencia que `resolveDianRecipient`, y la
    // misma solicitud que mira el envío (la más reciente de la orden).
    simpleInvoiceEmail: true,
    invoiceRequests: {
      orderBy: { createdAt: "desc" },
      take: 1,
      select: { email: true },
    },
    simpleInvoice: {
      select: {
        id: true,
        email: true,
        dianDocument: {
          select: {
            id: true,
            state: true,
            cufe: true,
            errors: true,
            emailedAt: true,
            lastError: true,
          },
        },
      },
    },
  },
} as const;

type OrderWithInvoice = {
  shortCode: string;
  totalCents: number;
  paidAt: Date | null;
  simpleInvoiceEmail: string | null;
  invoiceRequests: { email: string }[];
  simpleInvoice: {
    id: string;
    email: string | null;
    dianDocument: {
      id: string;
      state: string;
      cufe: string | null;
      errors: unknown;
      emailedAt: Date | null;
      lastError: string | null;
    } | null;
  } | null;
};

function toDian(order: OrderWithInvoice, einvoicingOn: boolean) {
  if (!einvoicingOn) return null;
  const inv = order.simpleInvoice;
  const doc = inv?.dianDocument ?? null;
  return {
    simpleInvoiceId: inv?.id ?? null,
    documentId: doc?.id ?? null,
    state: doc?.state ?? null,
    cufe: doc?.cufe ?? null,
    errors: Array.isArray(doc?.errors)
      ? (doc.errors as unknown[]).filter((e): e is string => typeof e === "string")
      : [],
    emailedAt: doc?.emailedAt?.toISOString() ?? null,
    lastError: doc?.lastError ?? null,
    emailTo: resolveDianRecipient({
      invoiceRequestEmail: order.invoiceRequests[0]?.email,
      simpleInvoiceEmail: inv?.email,
      orderSimpleInvoiceEmail: order.simpleInvoiceEmail,
    }),
  };
}

export default async function FacturasPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const t = await getTranslations("opFacturas");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const sp = await searchParams;
  const tab = sp.status === "generated" ? "generated" : "pending";

  const [restaurant, pending, generated] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { enabledModules: true },
    }),
    db.invoiceRequest.findMany({
      where: { restaurantId, status: "pending" },
      orderBy: { createdAt: "desc" },
      include: { order: orderInclude },
    }),
    db.invoiceRequest.findMany({
      where: { restaurantId, status: "generated" },
      orderBy: { generatedAt: "desc" },
      take: 100,
      include: { order: orderInclude },
    }),
  ]);

  const einvoicingOn = isModuleEnabled(restaurant?.enabledModules, "einvoicing");
  // Con emisión automática, una configuración incompleta frena TODAS las
  // facturas del comercio en silencio: el resumen es lo que lo hace visible.
  const emission = einvoicingOn ? await pendingEmissionSummary(restaurantId) : null;

  return (
    <FacturasClient
      tab={tab}
      einvoicingOn={einvoicingOn}
      emission={emission}
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
        dian: toDian(r.order, einvoicingOn),
        // Para "Imprimir en datáfono": presente si la tirilla ya se generó,
        // independiente del módulo einvoicing.
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
        dian: toDian(r.order, einvoicingOn),
        // Para "Imprimir en datáfono": presente si la tirilla ya se generó,
        // independiente del módulo einvoicing.
        simpleInvoiceId: r.order.simpleInvoice?.id ?? null,
      }))}
    />
  );
}
