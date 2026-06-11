/** Calling codes per country code */
const CALLING_CODES: Record<string, string> = {
  CO: "57",
  MX: "52",
};

/**
 * Normalize a raw phone input to E.164 format.
 *
 * Rules:
 * 1. Strip all non-digit characters (except a leading "+").
 * 2. If the input started with "+" treat the digits as already having a calling
 *    code — keep as-is.
 * 3. If digits already start with the calling code for `countryCode` and total
 *    length is ≥ 11, keep as-is (prepend "+").
 * 4. Otherwise prepend the calling code digits.
 * 5. Return null if final digit count is < 7.
 */
export function normalizePhone(raw: string, countryCode: string): string | null {
  const code = CALLING_CODES[countryCode.toUpperCase()];
  if (!code) return null;

  const trimmed = raw.trim();

  // Preserve whether input had a leading "+"
  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  let finalDigits: string;

  if (hadPlus) {
    // Caller asserts there is already a country code
    finalDigits = digits;
  } else if (digits.startsWith(code) && digits.length >= 11) {
    // Digits include the calling code already (e.g. "573001234567")
    finalDigits = digits;
  } else {
    // Prefix with calling code
    finalDigits = `${code}${digits}`;
  }

  if (finalDigits.length < 7) return null;
  return `+${finalDigits}`;
}

/** Returns a WhatsApp direct-message URL for an E.164 number. */
export function waLink(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  return `https://wa.me/${digits}`;
}
