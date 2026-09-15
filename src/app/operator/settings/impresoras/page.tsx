import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { stationPrintHealth } from "@/lib/print/stationPrintHealth";
import { PrintersClient } from "./PrintersClient";

export const dynamic = "force-dynamic";

/**
 * Configuración → Impresoras de red.
 *
 * Es una pantalla de DIAGNÓSTICO, no un editor. La config de cada
 * impresora (IP, puerto, estación, ancho) se escribe en el programa que
 * corre en el computador del local, porque quien instala está parado
 * frente a la impresora; acá se muestra lo que ese programa reporta.
 *
 * Lo que sí se hace desde acá, y es la razón de que la pantalla exista:
 * imprimir una prueba en la cocina sin estar en la cocina, y reimprimir
 * una comanda que no salió.
 */
export default async function PrintersSettingsPage() {
  const t = await getTranslations("opPrinters");
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const printerSelect = {
    id: true,
    localKey: true,
    label: true,
    host: true,
    port: true,
    kind: true,
    station: true,
    barSubStation: true,
    paperWidthMm: true,
    active: true,
  } as const;

  const [restaurant, agents, orphanPrinters, jobs] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        printPaperWidthMm: true,
        // Los toggles de Estaciones: una impresora activa de una estación
        // con la impresión apagada nunca recibe una comanda, y esta
        // pantalla tiene que decirlo en su fila.
        kitchenPrintEnabled: true,
        barPrintEnabled: true,
        kitchenAutoFire: true,
        barAutoFire: true,
        barSubStations: true,
      },
    }),
    db.printAgent.findMany({
      where: { restaurantId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        label: true,
        tokenTail: true,
        lastSeenAt: true,
        agentVersion: true,
        lastIp: true,
        revokedAt: true,
        printers: {
          where: { restaurantId },
          orderBy: [{ active: "desc" }, { label: "asc" }],
          select: printerSelect,
        },
      },
    }),
    // Impresoras sin agente (creadas a mano en soporte). No deberían
    // existir en el flujo normal, pero si existen tienen que verse: una
    // impresora invisible que recibe comandas es peor que una de más.
    db.printer.findMany({
      where: { restaurantId, agentId: null },
      orderBy: [{ active: "desc" }, { label: "asc" }],
      select: printerSelect,
    }),
    db.printJob.findMany({
      where: { restaurantId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        kind: true,
        status: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        printedAt: true,
        printer: { select: { id: true, label: true, active: true } },
      },
    }),
  ]);
  if (!restaurant) return <div className="p-6">{t("restaurantNotFound")}</div>;

  // Las de los agentes revocados/eliminados ya quedaron `active: false`
  // (lo hacen esas rutas), así que esta unión es lo mismo que ve el
  // encolado cuando filtra por activas.
  const health = stationPrintHealth({
    kitchenPrintEnabled: restaurant.kitchenPrintEnabled,
    barPrintEnabled: restaurant.barPrintEnabled,
    kitchenAutoFire: restaurant.kitchenAutoFire,
    barAutoFire: restaurant.barAutoFire,
    barSubStations: restaurant.barSubStations,
    printers: [...agents.flatMap((a) => a.printers), ...orphanPrinters],
  });

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
      >
        {tSettings("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">{t("title")}</div>
      <p className="text-sm text-op-muted mb-1">{t("intro")}</p>
      {/* Las instrucciones de instalación viven en Ayuda, no acá: esta
          pantalla es de diagnóstico. Sólo el enlace. */}
      <Link
        href="/operator/ayuda#impresoras"
        className="inline-block text-sm underline text-op-muted hover:text-ink mb-6"
      >
        {t("helpLink")}
      </Link>

      <PrintersClient
        serverNow={new Date().toISOString()}
        defaultPaperWidthMm={restaurant.printPaperWidthMm}
        health={health}
        agents={agents.map((a) => ({
          id: a.id,
          label: a.label,
          tokenTail: a.tokenTail,
          lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
          agentVersion: a.agentVersion,
          lastIp: a.lastIp,
          revokedAt: a.revokedAt?.toISOString() ?? null,
          printers: a.printers,
        }))}
        orphanPrinters={orphanPrinters}
        jobs={jobs.map((j) => ({
          id: j.id,
          kind: j.kind,
          status: j.status,
          attempts: j.attempts,
          lastError: j.lastError,
          createdAt: j.createdAt.toISOString(),
          printerId: j.printer.id,
          printerLabel: j.printer.label,
          printerActive: j.printer.active,
        }))}
      />
    </div>
  );
}
