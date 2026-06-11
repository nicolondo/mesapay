/** Calling codes per country code (exported for UI select lists) */
export const CALLING_CODES: Record<string, string> = {
  CO: "57",
  MX: "52",
  AR: "54",
  BR: "55",
  CL: "56",
  PE: "51",
  EC: "593",
  PA: "507",
  CR: "506",
  ES: "34",
};

/**
 * Normalize a raw phone input to E.164 format.
 *
 * Rules:
 * 1. Strip all non-digit characters (except a leading "+").
 * 2. If the input started with "+" treat the digits as a complete international
 *    number — return "+"+digits as-is. Requires ≥ 8 digits; else null.
 * 3. If digits already start with the calling code for `countryCode` and total
 *    length is ≥ (code.length + 7), keep as-is (prepend "+").
 *    This handles both 2-digit codes (CO=57, total≥11) and 3-digit codes
 *    (EC=593, total≥10; PA=507, total≥10; CR=506, total≥10).
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

  // Fast path: explicit international format.
  if (hadPlus) {
    // Caller explicitly provided an international number — trust it as-is.
    // Require ≥ 8 digits (shortest real E.164 country+subscriber: e.g. +1XXXXXXX).
    if (digits.length < 8) return null;
    return `+${digits}`;
  }

  let finalDigits: string;

  if (
    digits.startsWith(code) &&
    digits.length >= code.length + 7
  ) {
    // Digits include the calling code already (e.g. "573001234567" for CO,
    // or "59399123456" for EC). The threshold ensures we don't false-positive
    // on a local number that happens to start with the same digits.
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

/** Returns the native WhatsApp app URL scheme for an E.164 number. */
export function waAppLink(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  return `whatsapp://send?phone=${digits}`;
}
