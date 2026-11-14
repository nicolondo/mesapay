import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { PurchaseInvoiceSchema } from "@/lib/anthropic";
import { creditNotePrefillFromInvoice, type CreditNotePrefill } from "@/lib/erp/supplierCreditNoteAi";
import { parseCreditNoteListParams } from "@/lib/erp/supplierCreditNoteList";
import { loadCreditNoteListPage, resolvePrefillRefs } from "@/lib/erp/supplierCreditNoteQueries";
import { ComprasTabs } from "../ComprasTabs";
import { CreditNotesClient, type InitialReading } from "./CreditNotesClient";

export const dynamic = "force-dynamic";

/**
 * Compras › Notas crédito: las notas crédito de los proveedores (acuerdos
 * comerciales, descuentos, pronto pago y devoluciones). Lista filtrada en el
 * servidor (filtros en la URL) con su resumen; registrar una nota (a mano o
 * leída con IA) la aplica de una vez a las facturas pendientes y lo que
 * sobra queda como saldo a favor del proveedor.
 *
 * `?desdeFactura=<uploadId>`: la carga de facturas reconoció una nota
 * crédito; se abre el formulario prellenado con esa lectura (no se vuelve a
 * llamar a la IA). `?nota=<id>`: abre el detalle de esa nota.
 */
export default async function NotasCreditoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("opErp");
  const tc = await getTranslations("opSupplierCredit");
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true, country: true, purchaseIvaDeductible: true },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "purchasing")) notFound();

  const sp = await searchParams;
  const params = parseCreditNoteListParams(sp);
  const [list, allSuppliers, currency] = await Promise.all([
    loadCreditNoteListPage(restaurantId, params),
    db.supplier.findMany({
      where: { restaurantId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, taxId: true, active: true },
    }),
    getCurrencyForCountry(tenant.country),
  ]);

  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  // Lectura de «Cargar factura» que resultó ser una nota crédito.
  let initialReading: InitialReading | null = null;
  const uploadId = first(sp.desdeFactura);
  if (/^[a-z0-9]{10,40}$/i.test(uploadId)) {
    const upload = await db.purchaseInvoiceUpload.findFirst({
      where: { id: uploadId, restaurantId, status: "pending" },
      select: { id: true, fileUrl: true, extraction: true },
    });
    const parsed = upload ? PurchaseInvoiceSchema.safeParse(upload.extraction) : null;
    if (upload && parsed?.success) {
      const prefill: CreditNotePrefill = creditNotePrefillFromInvoice(parsed.data, tenant.country);
      const refs = await resolvePrefillRefs(restaurantId, prefill.supplierTaxId, prefill.referencedInvoiceNumbers);
      initialReading = { uploadId: upload.id, fileUrl: upload.fileUrl, prefill: { ...prefill, ...refs } };
    }
  }
  const nota = first(sp.nota);
  const initialDetailId =
    /^[a-z0-9]{10,40}$/i.test(nota) &&
    (await db.supplierCreditNote.findFirst({ where: { id: nota, restaurantId }, select: { id: true } }))
      ? nota
      : null;

  return (
    <div className="p-4 lg:p-6 max-w-6xl mx-auto w-full">
      <h1 className="font-display text-2xl lg:text-3xl tracking-[-0.015em]">{t("comprasTitle")}</h1>
      <p className="hidden sm:block text-sm text-op-muted mt-1 mb-5 max-w-2xl">{tc("pageIntro")}</p>
      <div className="h-4 sm:hidden" />
      <ComprasTabs active="credit_notes" />
      <CreditNotesClient
        list={list}
        params={params}
        suppliers={allSuppliers.filter((s) => s.active).map(({ id, name, taxId }) => ({ id, name, taxId }))}
        filterSuppliers={allSuppliers.map(({ id, name, taxId }) => ({ id, name, taxId }))}
        currency={currency}
        country={tenant.country}
        ivaDeductible={tenant.purchaseIvaDeductible}
        initialReading={initialReading}
        initialDetailId={initialDetailId}
      />
    </div>
  );
}
