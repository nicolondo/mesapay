import { getRestaurantKushkiMode, type KushkiMode } from "@/lib/platformConfig";
import { env } from "@/lib/env";
import { db } from "@/lib/db";
import { resolveEnabledPaymentMethods } from "@/lib/paymentMethods";

/**
 * ¿Puede este comercio cobrar con el Smart POS de Kushki? Las MISMAS
 * precondiciones que `terminal/charge` exige para empujar un cobro al
 * equipo, en un solo lugar:
 *
 *   - Datáfono REAL (Cloud Terminal) si el modo efectivo del comercio no es
 *     `mock` o si cargó su Business-Code; el Business-Code es la clave HMAC
 *     del cobro, sin él no se puede firmar (`cloud_business_code_missing`).
 *   - Al menos un `TerminalDevice` activo del comercio; con datáfono real,
 *     con serial (`invalid_device` / `device_no_serial`).
 *   - El mock no cobra en producción (`mock_payments_disabled`).
 *
 * `terminal-request` la usa para no crear una solicitud que nadie va a poder
 * empujar (Son y Melona, 2026-10-31: sin equipos ni Business-Code, la
 * solicitud dejó la cuenta trabada), y `PayFlow` para no mostrar el botón.
 */

type TerminalTenant = {
  id: string;
  kushkiMode?: string | null;
  cloudTerminalBusinessCode?: string | null;
};

export type KushkiTerminalSetup = {
  mode: KushkiMode;
  /** Clave HMAC del Cloud Terminal: la del comercio o, si no, la de plataforma. */
  businessCode: string | null;
  /** true = Cloud Terminal real (sandbox/producción); false = mock. */
  useRealTerminal: boolean;
};

/** Modo, Business-Code y si el cobro va al datáfono real o al mock. */
export async function kushkiTerminalSetup(tenant: TerminalTenant): Promise<KushkiTerminalSetup> {
  const mode = await getRestaurantKushkiMode(tenant);
  const businessCode = tenant.cloudTerminalBusinessCode || env.KUSHKI_BP_BUSINESS_CODE || null;
  return { mode, businessCode, useRealTerminal: mode !== "mock" || !!businessCode };
}

/** ¿Este equipo puede recibir un cobro? Activo y, con datáfono real, con serial. */
export function terminalDeviceUsable(
  device: { active: boolean; serialNumber: string | null },
  useRealTerminal: boolean,
): boolean {
  return device.active && (!useRealTerminal || !!device.serialNumber);
}

export type KushkiTerminalUnavailableReason =
  | "method_disabled"
  | "cloud_business_code_missing"
  | "mock_payments_disabled"
  | "no_device";

export type KushkiTerminalAvailability =
  | { available: true }
  | { available: false; reason: KushkiTerminalUnavailableReason };

/**
 * ¿Se puede ofrecer (y pedir) el datáfono Kushki? Además de lo que exige
 * `terminal/charge`, el método tiene que estar habilitado en el comercio.
 */
export async function kushkiTerminalAvailability(
  tenant: TerminalTenant & { enabledPaymentMethods?: unknown },
): Promise<KushkiTerminalAvailability> {
  if (!resolveEnabledPaymentMethods(tenant.enabledPaymentMethods).includes("kushki_card_terminal")) {
    return { available: false, reason: "method_disabled" };
  }
  const { businessCode, useRealTerminal } = await kushkiTerminalSetup(tenant);
  if (useRealTerminal && !businessCode) return { available: false, reason: "cloud_business_code_missing" };
  if (!useRealTerminal && process.env.NODE_ENV === "production") {
    return { available: false, reason: "mock_payments_disabled" };
  }
  const devices = await db.terminalDevice.findMany({
    where: { restaurantId: tenant.id, active: true },
    select: { active: true, serialNumber: true },
  });
  if (!devices.some((d) => terminalDeviceUsable(d, useRealTerminal))) {
    return { available: false, reason: "no_device" };
  }
  return { available: true };
}
