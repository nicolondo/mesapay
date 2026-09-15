import "server-only";
import { db } from "@/lib/db";
import { notifyAcceptedRoundTicketSafe } from "@/lib/print/enqueue";
import { defaultLocale, type Locale } from "@/i18n/config";
import type { AutoFiredRound } from "./autoFire";

/**
 * Idioma de la comanda que sale sola. La del tablero sale en el idioma de
 * quien tocó "Empezar" (su cookie); acá el request es del comensal —o de
 * un webhook de pago— y su idioma no es el del bartender. Se usa el del
 * país del comercio, mismo criterio que los correos al operador (ver
 * /api/cron/membership-reminders). Sin país, español.
 */
export function staffLocaleForCountry(
  country: string | null | undefined,
): Locale {
  switch ((country ?? "").toLowerCase()) {
    case "br":
      return "pt";
    case "us":
      return "en";
    default:
      return defaultLocale;
  }
}

/**
 * Imprime las comandas de los grupos marchados automáticamente: publica
 * `ticket.printable` (pestaña de Chrome) y encola `PrintJob` (agente de
 * impresión), exactamente como hace el tablero, y sólo para las estaciones
 * con la impresión activa.
 *
 * Se llama DESPUÉS de la transacción que marchó (imprimir hace i18n y DB
 * propias) y NUNCA lanza: una impresora caída no deshace un pedido. Sin
 * grupos no lee nada — el camino sin auto-fire no paga nada.
 */
export async function notifyAutoFiredTickets(args: {
  restaurantId: string;
  orderId: string;
  rounds: AutoFiredRound[];
}): Promise<void> {
  if (!args.rounds.some((r) => r.groups.length > 0)) return;
  try {
    const tenant = await db.restaurant.findUnique({
      where: { id: args.restaurantId },
      select: {
        kitchenPrintEnabled: true,
        barPrintEnabled: true,
        country: true,
      },
    });
    if (!tenant) return;
    const locale = staffLocaleForCountry(tenant.country);
    for (const round of args.rounds) {
      for (const group of round.groups) {
        const printEnabled =
          group.station === "kitchen"
            ? tenant.kitchenPrintEnabled
            : tenant.barPrintEnabled;
        if (!printEnabled) continue;
        await notifyAcceptedRoundTicketSafe({
          restaurantId: args.restaurantId,
          orderId: args.orderId,
          roundId: round.roundId,
          station: group.station,
          barSubStation: group.barSubStation,
          locale,
        });
      }
    }
  } catch (err) {
    console.error("[kds:auto-fire] no se pudo imprimir la comanda", err);
  }
}
