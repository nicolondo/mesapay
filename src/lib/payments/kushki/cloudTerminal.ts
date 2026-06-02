import { env } from "../../env";
import { getKushkiModeSync } from "../../platformConfig";

/**
 * Cliente del Kushki **Cloud Terminal API** (datáfono físico vía cloud).
 *
 * OJO: es una superficie de API DISTINTA del resto de Kushki (card/PSE/
 * wallet, que viven en api.kushkipagos.com con `Private-Merchant-Id`).
 * El Cloud Terminal corre sobre la infra de billpocket y se autentica con
 * el header `X-BP-AUTH`. Docs: docs.kushki.com → Card-present → Cloud
 * Terminal API.
 *
 * Flujo:
 *   1. POST /push-notifications { serialNumber, amount, uniqueReference… }
 *      → 201, sólo ACK. El equipo Ultra muestra el monto y lee la tarjeta.
 *   2. El resultado (aprobada/rechazada) llega por WEBHOOK a
 *      /api/webhooks/kushki-terminal (ver esa ruta).
 *
 * ⚠️ Campos marcados "(asumido)" todavía no están 100% verificados contra
 * un cobro real — dejamos logging defensivo para ajustar 1 línea cuando se
 * pruebe con un datáfono físico. Igual patrón que el init de PSE.
 */

const BASE_URL = {
  sandbox: "https://kushkicollect.billpocket.dev",
  production: "https://kushkicollect.billpocket.com",
} as const;

function baseUrl(): string {
  const mode = getKushkiModeSync();
  if (mode === "mock") {
    throw new Error("cloudTerminal must not be called in mock mode");
  }
  return BASE_URL[mode];
}

function bpAuth(): string {
  const auth = env.KUSHKI_BP_AUTH;
  if (!auth) {
    throw new Error(
      "KUSHKI_BP_AUTH no configurado — el datáfono cloud no puede cobrar. " +
        "Seteá la credencial del Cloud Terminal API en el .env del VPS.",
    );
  }
  return auth;
}

export type CloudTerminalPushArgs = {
  /** Serial del equipo Ultra (TerminalDevice.serialNumber). */
  serialNumber: string;
  /** Monto TOTAL a cobrar en centavos (ya incluye propina). */
  amountCents: number;
  /**
   * Referencia única nuestra — la usamos como idempotencyKey y para
   * matchear el webhook de vuelta. Usamos el Payment.id.
   */
  reference: string;
  /** Texto que se muestra en el datáfono / extracto. */
  description?: string;
};

export type CloudTerminalPushResult = {
  /** Lo que guardamos en Payment.providerRef para matchear el webhook. */
  providerRef: string;
  status: "queued" | "delivered" | "failed";
  message?: string;
};

/**
 * Manda el cobro al datáfono. Devuelve sólo el ACK — el aprobado/rechazado
 * viene después por webhook.
 */
export async function pushPaymentToCloudTerminal(
  args: CloudTerminalPushArgs,
): Promise<CloudTerminalPushResult> {
  // COP no tiene decimales → mandamos pesos enteros. (asumido: billpocket
  // espera el monto en unidades mayores, no centavos.)
  const amount = Math.round(args.amountCents / 100);
  const body = {
    serialNumber: args.serialNumber,
    amount,
    identifier: args.reference,
    uniqueReference: args.reference,
    ...(args.description ? { description: args.description } : {}),
    showNotification: true,
  };

  const url = baseUrl() + "/push-notifications";
  console.log("[kushki/cloud-terminal] push", {
    serialNumber: args.serialNumber,
    amount,
    reference: args.reference,
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-BP-AUTH": bpAuth(),
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (err) {
    console.error("[kushki/cloud-terminal] network error", err);
    throw err;
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    console.error(
      `[kushki/cloud-terminal] push ${res.status}: ${text.slice(0, 300)}`,
    );
    throw new Error(`cloud terminal push failed (${res.status})`);
  }
  console.log(
    "[kushki/cloud-terminal] push ack",
    text.slice(0, 400) || "(empty 201)",
  );

  return {
    // El push sólo es un ACK; matcheamos el resultado por uniqueReference
    // (= reference) en el webhook, así que ese es nuestro providerRef.
    providerRef: args.reference,
    status: "queued",
  };
}

/**
 * Cancela un cobro encolado en el datáfono. Best-effort — el path exacto
 * del cancel del Cloud Terminal no está documentado públicamente; usamos
 * el patrón documentado y logueamos. Si Kushki confirma otro path, es un
 * cambio de 1 línea.
 */
export async function cancelCloudTerminalPayment(
  serialNumber: string,
  reference: string,
): Promise<void> {
  const url = baseUrl() + "/push-notifications/cancel";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-BP-AUTH": bpAuth(),
      },
      body: JSON.stringify({ serialNumber, uniqueReference: reference }),
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(
        `[kushki/cloud-terminal] cancel ${res.status} (best-effort)`,
      );
    }
  } catch (err) {
    console.warn("[kushki/cloud-terminal] cancel error (best-effort)", err);
  }
}
