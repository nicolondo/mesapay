import { getTranslations } from "next-intl/server";
import { loadComprobantesContext } from "../../comprobantes/gate";
import { DiferidoDetailClient } from "./DiferidoDetailClient";

export const dynamic = "force-dynamic";

/**
 * Detalle de un diferido: valores, cuentas, asiento inicial, proyección
 * mes a mes y baja. El de OTRO comercio es un 404 del API.
 */
export default async function DiferidoDetailPage({
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
      <DiferidoDetailClient id={id} currency={ctx.currency} />
    </div>
  );
}
