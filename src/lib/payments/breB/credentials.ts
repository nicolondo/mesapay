import "server-only";
import { decrypt } from "@/lib/crypto";
import { hasBreBCredentials } from "@/lib/paymentMethods";

/**
 * Credenciales del comercio Bre-B de un restaurante. Kushki entrega para
 * Bre-B un comercio DISTINTO al de tarjeta/PSE: su par de llaves (y su
 * firma de webhook) viven en `Restaurant.kushkiBreB*`, cifradas igual que
 * `kushkiPrivateKeyEnc`. El modo (producción / sandbox→UAT / mock) es el
 * del comercio (`Restaurant.kushkiMode`), no uno propio.
 */

export type BreBCredentialFields = {
  kushkiBreBPublicKey: string | null;
  kushkiBreBPrivateKeyEnc: string | null;
};

export type BreBCredentials = { publicKey: string; privateKey: string };

/** ¿Están cargadas las DOS llaves? Sin ellas el medio no se puede habilitar. */
export function breBConfigured(tenant: BreBCredentialFields | null | undefined): boolean {
  return hasBreBCredentials(tenant);
}

/**
 * Llaves listas para llamar a Kushki, o null si faltan o no se pueden
 * descifrar. Nunca hay un valor por defecto: sin llaves no hay cobro.
 */
export function readBreBCredentials(tenant: BreBCredentialFields | null | undefined): BreBCredentials | null {
  if (!tenant || !breBConfigured(tenant)) return null;
  try {
    const privateKey = decrypt(tenant.kushkiBreBPrivateKeyEnc!);
    if (!privateKey) return null;
    return { publicKey: tenant.kushkiBreBPublicKey!.trim(), privateKey };
  } catch {
    return null;
  }
}

/** Firma del webhook del comercio Bre-B, o null si no está cargada. */
export function readBreBWebhookSecret(
  tenant: { kushkiBreBWebhookSecretEnc: string | null } | null | undefined,
): string | null {
  if (!tenant?.kushkiBreBWebhookSecretEnc) return null;
  try {
    return decrypt(tenant.kushkiBreBWebhookSecretEnc) || null;
  } catch {
    // Verificar con un secreto equivocado da falsos negativos: mejor rechazar.
    return null;
  }
}

/** "••••1a2b": lo único que se muestra de una llave guardada. */
export function maskKeyTail(value: string | null | undefined): string | null {
  const clean = value?.trim();
  if (!clean) return null;
  return `••••${clean.slice(-4)}`;
}

/** Últimos 4 de un valor cifrado, sin devolver nunca el valor entero. */
export function maskEncryptedTail(encrypted: string | null | undefined): string | null {
  if (!encrypted) return null;
  try {
    return maskKeyTail(decrypt(encrypted));
  } catch {
    return "••••";
  }
}
