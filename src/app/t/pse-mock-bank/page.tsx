import { redirect } from "next/navigation";

/**
 * Página mock que simula la web de un banco PSE. Llamada cuando estamos
 * en KUSHKI_MODE=mock — recibe los params que armó el mock provider y
 * después de un breve "delay" decide aprobar / rechazar (90% approved),
 * dispara el webhook simulado, y redirige de vuelta al cliente.
 *
 * En sandbox/production esta página nunca se invoca: la redirectUrl
 * viene de Kushki y apunta al banco real.
 */
export const dynamic = "force-dynamic";

export default async function PseMockBankPage({
  searchParams,
}: {
  searchParams: Promise<{
    ref?: string;
    bank?: string;
    amount?: string;
    return?: string;
    decide?: string;
  }>;
}) {
  const params = await searchParams;
  const ref = params.ref;
  const returnUrl = params.return;

  if (!ref || !returnUrl) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            PSE · Banco simulado
          </div>
          <h1 className="font-display text-2xl mb-2">Parámetros inválidos</h1>
          <p className="text-sm text-op-muted">
            Esta página simula un banco PSE y necesita los parámetros del
            init. Volvé al checkout e intentá de nuevo.
          </p>
        </div>
      </div>
    );
  }

  // "decide" deja override manual; si no viene, decidimos random 90% aprob.
  const outcome: "approved" | "declined" =
    params.decide === "approved" || params.decide === "declined"
      ? params.decide
      : Math.random() < 0.9
        ? "approved"
        : "declined";

  // Antes de resolver, aseguramos que el bridge esté instalado en
  // este proceso — sino el evento simulado no tiene listener que lo
  // procese y el Payment queda colgado en pending.
  const { ensureMockBridge } = await import("@/lib/payments/mockBridge");
  ensureMockBridge();

  // Resolver el pending en el mock provider — esto dispara el webhook
  // simulado que el handler real procesa.
  const { resolveMockPse } = await import("@/lib/payments/kushki/mock");
  await resolveMockPse(ref, outcome);

  // Redirigimos de vuelta al cliente con el outcome en query.
  const back = new URL(returnUrl);
  back.searchParams.set("status", outcome);
  redirect(back.toString());
}
