/**
 * Renders a CRM email template by replacing {{variable}} placeholders.
 *
 * - Tolerates spaces: {{ nombre }}, {{nombre}}, {{ nombre}} all match.
 * - Unknown keys → replaced with empty string.
 * - Values are HTML-escaped to prevent injection in bodyHtml.
 */

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) return "";
    return escapeHtml(value);
  });
}

/**
 * Las plantillas suelen escribirse como texto plano con saltos de línea,
 * pero el correo se envía como HTML — donde los \n colapsan en espacios.
 * Si el cuerpo NO tiene estructura de bloques HTML, convertimos los saltos
 * de línea en <br> para que el correo (y la vista previa) respeten el
 * formato. Si ya trae bloques (<p>, <br>, <div>, …) se deja intacto.
 */
export function nl2brIfPlain(html: string): string {
  if (/<\s*(br|p|div|table|ul|ol|h[1-6])\b/i.test(html)) return html;
  return html.replace(/\r\n|\n/g, "<br>");
}
