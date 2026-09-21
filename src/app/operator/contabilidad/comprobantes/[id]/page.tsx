import { getTranslations } from "next-intl/server";
import { loadComprobantesContext } from "../gate";
import { ComprobanteDetailClient } from "./ComprobanteDetailClient";

export const dynamic = "force-dynamic";

/**
 * Detalle de un comprobante: encabezado + líneas débito/crédito por cuenta
 * y acciones (editar/eliminar/reversar) según lo que permita el servidor.
 * El comprobante de OTRO comercio es un 404 del API (where con restaurantId).
 */
export default async function ComprobanteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tSettings = await getTranslations("opSettings");
  const ctx = await loadComprobantesContext();
  if (ctx === "no_restaurant") {
    return <div className="p-6">{tSettings("noRestaurant")}</div>;
  }
  return (
    <div className="p-6 max-w-4xl mx-auto w-full">
      <ComprobanteDetailClient id={id} currency={ctx.currency} />
    </div>
  );
}
