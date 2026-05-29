import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { fmtBogotaDateTime } from "@/lib/bogota";
import { ManageReservationClient } from "./ManageReservationClient";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, { label: string; tint: string }> = {
  pending: { label: "Pendiente de confirmación", tint: "bg-[#C98A2E]/15 text-[#8F6828]" },
  confirmed: { label: "Confirmada", tint: "bg-[#2E6B4C]/15 text-[#1E5339]" },
  seated: { label: "En el restaurante", tint: "bg-[#2E6B4C]/15 text-[#1E5339]" },
  completed: { label: "Completada", tint: "bg-paper text-muted" },
  cancelled: { label: "Cancelada", tint: "bg-danger/15 text-danger" },
  no_show: { label: "No asistió", tint: "bg-danger/15 text-danger" },
};

function prettyWhen(d: Date): string {
  const b = new Date(d.getTime() - 5 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000); // identidad; usamos fmt local abajo
  void b;
  const f = fmtBogotaDateTime(d);
  // f.date es YYYY-MM-DD; reconstruimos lindo.
  const [y, m, dd] = f.date.split("-").map(Number);
  const fecha = new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  return `${fecha} · ${f.time}`;
}

export default async function ManageReservationPage({
  params,
}: {
  params: Promise<{ slug: string; code: string }>;
}) {
  const { slug, code } = await params;

  const reservation = await db.reservation.findUnique({
    where: { confirmationCode: code },
    include: {
      restaurant: { select: { name: true, slug: true, legalCity: true } },
      table: { select: { number: true, label: true } },
    },
  });

  if (!reservation || reservation.restaurant.slug !== slug) return notFound();

  const status = STATUS_LABEL[reservation.status] ?? {
    label: reservation.status,
    tint: "bg-paper text-muted",
  };
  // Cancelable solo si está pendiente/confirmada y todavía no empezó.
  const cancelable =
    (reservation.status === "pending" || reservation.status === "confirmed") &&
    reservation.startsAt.getTime() > Date.now();

  return (
    <main className="min-h-dvh bg-bone text-ink flex flex-col items-center px-6 py-12">
      <div className="max-w-sm w-full">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
          {reservation.restaurant.name}
          {reservation.restaurant.legalCity
            ? ` · ${reservation.restaurant.legalCity}`
            : ""}
        </div>
        <h1 className="font-display text-3xl mb-4">Tu reserva</h1>

        <div className="rounded-2xl border border-hairline bg-paper p-5 mb-5">
          <span
            className={
              "inline-flex items-center h-7 px-3 rounded-full text-[11px] font-medium mb-4 " +
              status.tint
            }
          >
            {status.label}
          </span>
          <table className="w-full text-sm">
            <tbody>
              <tr>
                <td className="text-muted py-1">Fecha</td>
                <td className="text-right font-medium">
                  {prettyWhen(reservation.startsAt)}
                </td>
              </tr>
              <tr>
                <td className="text-muted py-1">Personas</td>
                <td className="text-right font-medium">
                  {reservation.partySize}
                </td>
              </tr>
              <tr>
                <td className="text-muted py-1">Mesa</td>
                <td className="text-right font-medium">
                  {reservation.table.label ??
                    `Mesa ${reservation.table.number}`}
                </td>
              </tr>
              <tr>
                <td className="text-muted py-1">A nombre de</td>
                <td className="text-right font-medium">
                  {reservation.customerName}
                </td>
              </tr>
              <tr>
                <td className="text-muted py-2.5">Código</td>
                <td className="text-right font-display text-lg pt-2.5">
                  {reservation.confirmationCode}
                </td>
              </tr>
            </tbody>
          </table>
          {reservation.notes && (
            <p className="mt-3 pt-3 border-t border-hairline text-xs text-muted">
              Nota: {reservation.notes}
            </p>
          )}
        </div>

        <ManageReservationClient
          tenantSlug={slug}
          code={reservation.confirmationCode}
          cancelable={cancelable}
          alreadyCancelled={
            reservation.status === "cancelled" ||
            reservation.status === "no_show"
          }
        />
      </div>
    </main>
  );
}
