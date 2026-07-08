import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { isModuleEnabled } from "@/lib/modules";
import { KioskoClient } from "./KioskoClient";

export const dynamic = "force-dynamic";

/**
 * Kiosko de asistencia — ERP Fase C2 · D1: la tablet del local (ya
 * logueada como operador) muestra reloj + botones grandes Entrada/Salida;
 * el empleado marca con la cara (match local con face-api) o eligiendo su
 * nombre, siempre con foto de evidencia. Mismo gate estricto que
 * /operator/horarios: solo existe con el módulo `staff` activo.
 *
 * Usa el layout normal del operador (la tablet igual necesita la nav para
 * salir del kiosko); la página en sí ocupa el alto disponible y centra su
 * contenido — todo el estado vive en el client (cámara, face-api, punch).
 */
export default async function KioskoPage() {
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return <div className="p-6">{tSettings("noRestaurant")}</div>;
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "staff")) {
    notFound();
  }

  return <KioskoClient />;
}
