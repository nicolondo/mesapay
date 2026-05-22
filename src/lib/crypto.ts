import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type CipherGCM,
  type DecipherGCM,
} from "crypto";
import { requireSecretKey } from "./env";

/**
 * AES-256-GCM encryption for at-rest secrets (e.g. Kushki sub-merchant
 * private keys). Output format is base64 of `iv || tag || ciphertext` so we
 * can store a single opaque string in Postgres and round-trip cleanly.
 *
 * We use a single master key (MESAPAY_SECRET_KEY) for now. If we ever need
 * key rotation, prepend a version byte to the payload and key-derive per
 * version.
 */

const IV_BYTES = 12; // GCM-recommended IV size
const TAG_BYTES = 16;

function keyBuffer(): Buffer {
  return Buffer.from(requireSecretKey(), "hex");
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBuffer(), iv) as CipherGCM;
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error("ciphertext too short");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const enc = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyBuffer(),
    iv,
  ) as DecipherGCM;
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
    "utf8",
  );
}

/**
 * Safe-decrypt: if the value isn't a valid envelope, return null instead of
 * throwing. Useful when reading a field that's optionally encrypted.
 */
export function tryDecrypt(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    return decrypt(payload);
  } catch {
    return null;
  }
}
