import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { simulateBreBMock, type BreBMockDecision } from "@/lib/payments/breB/service";

/**
 * "App del banco" simulada para Bre-B en modo demo (KUSHKI_MODE=mock), como
 * `/t/pse-mock-bank` para PSE. La pantalla del QR la abre con «Simular el
 * banco (demo)»: acá se decide qué "contesta Kushki" y el resultado pasa por
 * el MISMO camino de verificación que un aviso real —por eso «otro monto» no
 * aprueba: deja el cobro para revisión.
 *
 * Nunca existe en producción ni para un cobro que no sea de modo mock.
 */
export const dynamic = "force-dynamic";

const DECISIONS: BreBMockDecision[] = ["approved", "declined", "wrong_amount"];

export default async function BreBMockPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; decide?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { c, decide } = await searchParams;
  if (!c) notFound();
  const charge = await db.breBCharge.findUnique({ where: { id: c } });
  if (!charge || charge.mode !== "mock") notFound();

  const t = await getTranslations("breB");
  const locale = (await getLocale()) as Locale;
  const decision = DECISIONS.find((d) => d === decide) ?? null;
  // Sólo se puede decidir mientras el código sigue vivo.
  const outcome = decision && charge.status === "active" ? await simulateBreBMock(charge.id, decision) : null;
  const current = outcome ? await db.breBCharge.findUnique({ where: { id: c } }) : charge;
  const amount = formatMoney(charge.amountCents, { currency: charge.currency, locale });
  const open = current?.status === "active";

  return (
    <main className="min-h-dvh bg-paper text-ink flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-3xl border border-hairline bg-bone p-6 text-center">
        <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">{t("mock.kicker")}</div>
        <h1 className="font-display text-3xl mt-1">{t("mock.title")}</h1>
        <div className="font-display text-4xl tabular mt-4">{amount}</div>
        <p className="text-sm text-muted mt-2">{t("mock.intro")}</p>

        {outcome && (
          <p className="mt-4 rounded-xl bg-ivory p-3 text-sm" role="status">
            {t(`mock.result_${outcome}`)}
          </p>
        )}

        {open ? (
          <div className="mt-5 space-y-2">
            <a
              href={`/t/bre-b-mock?c=${encodeURIComponent(charge.id)}&decide=approved`}
              className="mp-pay mp-pay--ink text-sm"
            >
              {t("mock.approve")}
            </a>
            <a
              href={`/t/bre-b-mock?c=${encodeURIComponent(charge.id)}&decide=declined`}
              className="mp-pay mp-pay--outline text-sm"
            >
              {t("mock.decline")}
            </a>
            <a
              href={`/t/bre-b-mock?c=${encodeURIComponent(charge.id)}&decide=wrong_amount`}
              className="mp-pay mp-pay--outline text-sm"
            >
              {t("mock.wrongAmount")}
            </a>
          </div>
        ) : (
          <p className="mt-5 text-sm text-muted">{t("mock.closed", { status: current?.status ?? "" })}</p>
        )}
        <p className="mt-5 text-xs text-muted-2">{t("mock.footer")}</p>
      </div>
    </main>
  );
}
