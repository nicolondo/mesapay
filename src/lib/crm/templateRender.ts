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
