// Helper centralizado para resolver el logo del comercio. Cualquier
// vista pública (menú del cliente, factura, pickup, etc.) usa
// `restaurantLogoSrc()` para evitar conditional fallbacks ad-hoc en
// cada página.
//
// Fallback: cuando el comercio no subió logo, usamos el icono de
// MESAPAY que ya vive en /public/icons/icon-192.png. Es el mismo
// que sirve la PWA, así que está siempre disponible.

export const MESAPAY_FALLBACK_LOGO = "/icons/icon-192.png";

export function restaurantLogoSrc(logoUrl: string | null | undefined): string {
  if (logoUrl && logoUrl.trim().length > 0) return logoUrl;
  return MESAPAY_FALLBACK_LOGO;
}

/** Marca que indica si lo que devuelve es el del comercio o el fallback. */
export function hasOwnLogo(logoUrl: string | null | undefined): boolean {
  return !!(logoUrl && logoUrl.trim().length > 0);
}
