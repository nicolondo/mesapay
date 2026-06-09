/** lower, sin acentos, trim, espacios colapsados. Devuelve null si <2 chars. */
export function normalizeTerm(raw: string): string | null {
  const t = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
  return t.length >= 2 ? t : null;
}
