import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { fmtBogotaDateTime } from "@/lib/bogota";
import { ManageReservationClient } from "./ManageReservationClient";

export const dynamic = "force-dynamic";

const STATUS_META: Record<string, { key: string; tint: string }> = {
  pending: { key: "statusPending", tint: "bg-[#C98A2E]/15 text-[#8F6828]" },
  confirmed: { key: "statusConfirmed", tint: "bg-[#2E6B4C]/15 text-[#1E5339]" },
  seated: { key: "statusSeated", tint: "bg-[#2E6B4C]/15 text-[#1E5339]" },
  completed: { key: "statusCompleted", tint: "bg-paper text-muted" },
  cancelled: { key: "statusCancelled", tint: "bg-danger/15 text-danger" },
  no_show: { key: "statusNoShow", tint: "bg-danger/15 text-danger" },
};

function prettyWhen(d: Date, locale: Locale): string {
  // formatDate usa America/Bogota por defecto — mismo día calendario que
  // fmtBogotaDateTime, del que conservamos la hora HH:MM.
  const fecha = formatDate(d, {
    locale,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return `${fecha} · ${fmtBogotaDateTime(d).time}`;
}

export default async function ManageReservationPage({
  params,
}: {
  params: Promise<{ slug: string; code: string }>;
}) {
  const { slug, code } = await params;
  const t = await getTranslations("reservar");
  const locale = (await getLocale()) as Locale;

  const reservation = await db.reservation.findUnique({
    where: { confirmationCode: code },
    include: {
      restaurant: { select: { name: true, slug: true, legalCity: true } },
      table: { select: { number: true, label: true } },
    },
  });

  if (!reservation || reservation.restaurant.slug !== slug) return notFound();

  const statusMeta = STATUS_META[reservation.status];
  const statusLabel = statusMeta ? t(statusMeta.key) : reservation.status;
  const statusTint = statusMeta?.tint ?? "bg-paper text-muted";
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
        <h1 className="font-display text-3xl mb-4">{t("yourReservation")}</h1>

        <div className="rounded-2xl border border-hairline bg-paper p-5 mb-5">
          <span
            className={
              "inline-flex items-center h-7 px-3 rounded-full text-[11px] font-medium mb-4 " +
              statusTint
            }
          >
            {statusLabel}
          </span>
          <table className="w-full text-sm">
            <tbody>
              <tr>
                <td className="text-muted py-1">{t("dateLabel")}</td>
                <td className="text-right font-medium">
                  {prettyWhen(reservation.startsAt, locale)}
                </td>
              </tr>
              <tr>
                <td className="text-muted py-1">{t("fieldPeople")}</td>
                <td className="text-right font-medium">
                  {reservation.partySize}
                </td>
              </tr>
              <tr>
                <td className="text-muted py-1">{t("fieldTable")}</td>
                <td className="text-right font-medium">
                  {reservation.table.label ??
                    t("tableN", { number: reservation.table.number })}
                </td>
              </tr>
              <tr>
                <td className="text-muted py-1">{t("fieldName")}</td>
                <td className="text-right font-medium">
                  {reservation.customerName}
                </td>
              </tr>
              <tr>
                <td className="text-muted py-2.5">{t("fieldCode")}</td>
                <td className="text-right font-display text-lg pt-2.5">
                  {reservation.confirmationCode}
                </td>
              </tr>
            </tbody>
          </table>
          {reservation.notes && (
            <p className="mt-3 pt-3 border-t border-hairline text-xs text-muted">
              {t("noteLine", { note: reservation.notes })}
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
