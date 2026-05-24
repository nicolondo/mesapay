import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { PrintListener } from "./PrintListener";

export const dynamic = "force-dynamic";

/**
 * Print listener page. Open this on the kitchen / bar computer with a
 * thermal printer attached as the OS default printer. The page
 * subscribes to the tenant SSE bus and, when a `ticket.printable`
 * event arrives for this station (+ optional sub), fetches the ticket
 * data and pushes it through window.print() inside a hidden iframe.
 *
 * URL shape:
 *   /operator/print/cocina
 *   /operator/print/bar
 *   /operator/print/bar?sub=Cocteles
 *
 * For zero-friction silent printing, Chrome can be started with
 *   chrome --kiosk-printing
 * which auto-confirms the print dialog. We document this on the page.
 */
export default async function PrintStationPage({
  params,
  searchParams,
}: {
  params: Promise<{ station: string }>;
  searchParams: Promise<{ sub?: string }>;
}) {
  const { station: raw } = await params;
  // Accept both Spanish & English aliases.
  const station: "kitchen" | "bar" =
    raw === "cocina" || raw === "kitchen"
      ? "kitchen"
      : raw === "bar"
        ? "bar"
        : (notFound() as never);

  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) redirect("/operator");
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      slug: true,
      name: true,
      hasBar: true,
      barSubStations: true,
      kitchenPrintEnabled: true,
      barPrintEnabled: true,
      printPaperWidthMm: true,
    },
  });
  if (!tenant) redirect("/operator");

  const { sub: rawSub } = await searchParams;
  const sub =
    rawSub && tenant.barSubStations.includes(rawSub) ? rawSub : null;

  const stationEnabled =
    station === "kitchen" ? tenant.kitchenPrintEnabled : tenant.barPrintEnabled;

  return (
    <PrintListener
      tenantSlug={tenant.slug}
      tenantName={tenant.name}
      station={station}
      barSubStation={sub}
      stationEnabled={stationEnabled}
      paperWidthMm={tenant.printPaperWidthMm}
      availableSubStations={station === "bar" ? tenant.barSubStations : []}
    />
  );
}
