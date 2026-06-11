/** Generic words stripped when normalizing a lead name for duplicate detection. */
const GENERIC_WORDS = new Set([
  "restaurante",
  "restaurant",
  "sas",
  "sas",
  "sa",
  "ltda",
  "limitada",
  "y",
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
]);

/**
 * Normalize a lead/business name for fuzzy duplicate detection.
 *
 * Steps:
 * 1. Lowercase.
 * 2. Remove accents / diacritics (NFD + strip combining marks).
 * 3. Remove punctuation (including dots so "s.a.s." → "sas").
 * 4. Split by whitespace and filter out generic words.
 * 5. Re-join with a single space.
 */
export function normalizeLeadName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/\./g, "") // remove dots first (s.a.s. → sas, not s a s)
    .replace(/[^a-z0-9\s]/g, " ") // remaining punctuation → space
    .split(/\s+/)
    .filter((w) => w.length > 0 && !GENERIC_WORDS.has(w))
    .join(" ")
    .trim();
}
