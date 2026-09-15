import { getRestaurantPrivateKey } from "@/lib/payments";
import { getRestaurantKushkiMode, type KushkiMode } from "@/lib/platformConfig";

/**
 * Consulta el estado de un token PSE en Kushki (`/transfer/v1/status`).
 * Lo usan las páginas de retorno del banco: el webhook es order-céntrico
 * y no se puede depender de él para un cobro sin Order (depósito de
 * reserva, link de pago). Mock ⇒ "pending" (el mock confirma al iniciar).
 */
export type PseStatus = "approved" | "declined" | "pending";

export function kushkiApiBase(mode: KushkiMode): string {
  return mode === "production"
    ? "https://api.kushkipagos.com"
    : "https://api-uat.kushkipagos.com";
}

export async function fetchPseTokenStatus(args: {
  restaurant: { id: string; kushkiMode: string | null };
  token: string;
}): Promise<PseStatus> {
  const mode = await getRestaurantKushkiMode(args.restaurant);
  if (mode === "mock") return "pending";
  const privateKey = await getRestaurantPrivateKey(args.restaurant.id);
  if (!privateKey) return "pending";
  try {
    const res = await fetch(
      `${kushkiApiBase(mode)}/transfer/v1/status/${encodeURIComponent(args.token)}`,
      {
        method: "GET",
        headers: { "Private-Merchant-Id": privateKey },
        cache: "no-store",
      },
    );
    if (!res.ok) return "pending";
    const json = (await res.json()) as { status?: string };
    if (json.status === "approvedTransaction") return "approved";
    if (json.status === "declinedTransaction") return "declined";
    return "pending";
  } catch (err) {
    console.error("[pse-status] check failed", err);
    return "pending";
  }
}
