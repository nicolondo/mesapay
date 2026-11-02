/**
 * Chequeo de voseo para los textos en español que escribimos nosotros
 * (artículos de ayuda y documentos legales): el español de MESAPAY es neutro,
 * con "tú" o impersonal. Lo comparten los tests de contenido.
 */

/** Formas de vos que no existen con tú/usted. */
export const VOSEO_RE =
  /\b(tocá|tocás|elegí|escribí|abrí|entrá|andá|mirá|revisá|pegá|copiá|guardá|poné|hacé|tené|podés|tenés|querés|sabés|necesitás|usá|probá|fijate|apretá|activá|cerrá|cargá|subí|creá|dejá|pedile|decile|escribinos|mandanos|avisanos|vos)\b/i;

/**
 * Primera forma de voseo encontrada, o null. Se revisa el texto fuera de los
 * bloques de código, las **negritas** y el `código`, que es donde van las
 * etiquetas exactas de la interfaz (algunas todavía están con vos).
 */
export function findVoseo(text: string): string | null {
  const clean = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\*\*[^*]+\*\*/g, "")
    .replace(/`[^`]*`/g, "");
  return VOSEO_RE.exec(clean)?.[0] ?? null;
}
