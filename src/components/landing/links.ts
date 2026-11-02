/**
 * Destinos y estilos compartidos de la landing pública (mesapay.co).
 *
 * El contacto público es UNO solo: info@mesapay.co (sin teléfono ni
 * WhatsApp). "Agenda una demo" abre un correo con el asunto ya escrito en
 * el idioma del visitante.
 */

export const CONTACT_EMAIL = "info@mesapay.co";

export const ROUTES = {
  /** Presentación comercial pública (20 pantallas, móvil primero). */
  deck: "/presentacion",
  /** Registro del restaurante (crea el comercio en plan de prueba). */
  signup: "/signup/restaurant",
  signin: "/signin",
  privacy: "/privacidad",
  terms: "/terminos",
} as const;

/** Anclas de las secciones; la cabecera y el pie apuntan a ellas. */
export const SECTION = {
  content: "contenido",
  product: "producto",
  start: "empezar",
  plans: "planes",
  faq: "preguntas",
} as const;

/** `mailto:` de la demo con el asunto traducido (ya codificado). */
export function demoMailto(subject: string): string {
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

/* ---------- Botones: esquinas suaves (--radius-btn), nunca píldora ---------- */

const BTN =
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius-btn)] font-medium whitespace-nowrap transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2";

/** Botón principal sobre fondos claros. */
export const btnPrimary = `${BTN} h-12 px-6 text-[15px] bg-ink text-bone hover:bg-ink-2 focus-visible:outline-ink`;

/** Botón secundario sobre fondos claros. */
export const btnSecondary = `${BTN} h-12 px-5 text-[15px] border border-hairline-2 bg-ivory/80 text-ink hover:bg-ivory hover:border-ink/30 focus-visible:outline-ink`;

/** Botón principal sobre fondo tinta (terracota oscuro: contraste AA con hueso). */
export const btnOnDark = `${BTN} h-12 px-6 text-[15px] bg-terracotta-2 text-bone hover:bg-[#93381B] focus-visible:outline-bone`;

/** Botón secundario sobre fondo tinta. */
export const btnOnDarkGhost = `${BTN} h-12 px-5 text-[15px] border border-bone/25 text-bone hover:bg-bone/10 focus-visible:outline-bone`;

/** Botón compacto de la cabecera. */
export const btnHeader = `${BTN} h-10 px-3.5 text-[14px] bg-ink text-bone hover:bg-ink-2 focus-visible:outline-ink`;

/** Rótulo en mayúsculas (mono) que encabeza cada sección. */
export const eyebrow =
  "font-mono text-[11px] font-medium uppercase tracking-[0.2em]";
