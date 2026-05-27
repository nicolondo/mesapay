import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";

/**
 * Página a la que el banco (o la página mock) redirige al cliente
 * cuando termina el flujo PSE. No es la fuente de verdad del estado
 * del Payment — ese viene por webhook. Acá leemos el estado actual
 * del Payment desde la DB y mostramos un mensaje coherente.
 *
 * Si el webhook ya llegó:
 *   - approved → mensaje OK + link a la cuenta
 *   - declined → mensaje error + reintentar
 *
 * Si todavía no llegó (caso normal: PSE puede demorar segundos):
 *   - mostramos "Procesando..." con auto-refresh cada 3s
 */
export const dynamic = "force-dynamic";

export default async function PseReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; orderId: string }>;
  searchParams: Promise<{ pid?: string; status?: string }>;
}) {
  const { slug, orderId } = await params;
  const { pid, status: statusHint } = await searchParams;

  if (!pid) {
    redirect(`/t/${slug}/pay/${orderId}`);
  }

  const payment = await db.payment.findUnique({
    where: { id: pid },
    select: {
      id: true,
      status: true,
      method: true,
      amountCents: true,
      tipCents: true,
      orderId: true,
    },
  });

  if (!payment || payment.orderId !== orderId) {
    redirect(`/t/${slug}/pay/${orderId}`);
  }

  // payment.amountCents YA es el TOTAL (food + tip).
  const total = payment.amountCents;
  const fmt = (cents: number) =>
    "$" + (cents / 100).toLocaleString("es-CO");

  // Estado canónico: la DB. El statusHint del query string es solo el
  // hint del banco, sirve como mensaje preliminar si el webhook
  // todavía no procesó.
  const isApproved = payment.status === "approved";
  const isDeclined = payment.status === "declined";
  const isPending = payment.status === "pending";

  return (
    <div className="min-h-screen bg-paper flex flex-col items-center justify-center p-6">
      <div className="max-w-sm w-full text-center">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
          PSE · Transferencia bancaria
        </div>
        {isApproved && (
          <>
            <div className="text-5xl mb-3">✓</div>
            <h1 className="font-display text-2xl mb-2">
              Pago aprobado
            </h1>
            <p className="text-sm text-op-muted mb-1">
              Cobramos {fmt(total)} a tu cuenta bancaria.
            </p>
            <p className="text-xs text-op-muted mb-6">
              Ya quedó registrado. ¡Gracias!
            </p>
            <Link
              href={`/t/${slug}/pay/${orderId}`}
              className="inline-flex items-center justify-center h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium"
            >
              Volver a la cuenta
            </Link>
          </>
        )}
        {isDeclined && (
          <>
            <div className="text-5xl mb-3">✕</div>
            <h1 className="font-display text-2xl mb-2">
              Pago rechazado
            </h1>
            <p className="text-sm text-op-muted mb-6">
              {statusHint === "declined"
                ? "Tu banco rechazó la transferencia. Podés intentar con otro método o reintentar PSE."
                : "El pago no se completó. Reintentá con otro método."}
            </p>
            <Link
              href={`/t/${slug}/pay/${orderId}`}
              className="inline-flex items-center justify-center h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium"
            >
              Reintentar
            </Link>
          </>
        )}
        {isPending && (
          <>
            <div className="text-5xl mb-3 animate-pulse">⏳</div>
            <h1 className="font-display text-2xl mb-2">Procesando…</h1>
            <p className="text-sm text-op-muted mb-1">
              Estamos confirmando el resultado de tu transferencia con tu
              banco. Puede tardar unos segundos.
            </p>
            <p className="text-xs text-op-muted mb-6">
              Esta página se actualiza automáticamente.
            </p>
            {/* Auto-refresh cada 3s sin JS. */}
            <meta httpEquiv="refresh" content="3" />
            <Link
              href={`/t/${slug}/pay/${orderId}`}
              className="text-xs text-op-muted underline"
            >
              Volver al checkout
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
