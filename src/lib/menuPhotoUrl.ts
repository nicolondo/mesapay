/**
 * ¿Es una URL de foto de plato aceptable para guardar?
 *
 *  - `/uploads/...` — archivo local (subido por el operador o descargado por
 *    el flujo de import).
 *  - `https://` de un CDN de plataforma de menús confiable (Cluvi/Shopify/
 *    Justo) — el import deja estas URLs cuando la descarga server-side de la
 *    imagen falla (p.ej. el CDN limita la IP del servidor). El menú del
 *    comensal las pinta directo como CSS background-image.
 *
 * El match por sufijo es seguro: solo la marca controla sus subdominios.
 * Usado por el endpoint de import (confirm) y el de edición de plato, así
 * un plato con foto de CDN se puede editar sin que lo rechace la validación.
 */
export function isAllowedMenuPhotoUrl(u: string): boolean {
  if (u.startsWith("/uploads/")) return true;
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase();
    return (
      h === "images.cluvi.com" ||
      h.endsWith(".getjusto.com") ||
      h.endsWith(".shopify.com") ||
      h.endsWith(".myshopify.com") ||
      h.endsWith(".shopifycdn.com")
    );
  } catch {
    return false;
  }
}
