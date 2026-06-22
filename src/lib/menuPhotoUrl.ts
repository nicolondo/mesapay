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
    // Menüpp sirve sus fotos desde una distribución de CloudFront
    // (p.ej. dvzwo3mu4ucsq.cloudfront.net) con el path firmado
    // `/images/restaurants/<slug>/...`. CloudFront es un CDN compartido,
    // así que no alcanza el sufijo: exigimos también ese path-prefix —
    // la firma de Menüpp — para no abrir *.cloudfront.net entero. (Igual
    // que el resto, solo aplica al fallback cuando la descarga server-side
    // falla; la foto se pinta como CSS background-image, sin SSRF.)
    if (
      h.endsWith(".cloudfront.net") &&
      url.pathname.startsWith("/images/restaurants/")
    ) {
      return true;
    }
    return (
      // Cualquier subdominio de cluvi.com / cluvi.co — el importador de Cluvi
      // (menuImportCluvi) acepta imágenes de todo *.cluvi.(co|com), así que la
      // validación de guardado debe aceptar lo mismo (antes solo permitía
      // images.cluvi.com y rechazaba fotos servidas desde otros subdominios).
      h === "cluvi.com" ||
      h.endsWith(".cluvi.com") ||
      h === "cluvi.co" ||
      h.endsWith(".cluvi.co") ||
      h.endsWith(".getjusto.com") ||
      h.endsWith(".shopify.com") ||
      h.endsWith(".myshopify.com") ||
      h.endsWith(".shopifycdn.com")
    );
  } catch {
    return false;
  }
}
