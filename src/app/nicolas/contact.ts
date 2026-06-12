/**
 * Datos de la tarjeta digital de Nicolás. Son datos (no copy de UI), por eso
 * viven como constantes y se renderizan vía expresiones — el copy traducible
 * está en messages/{es,en,pt}.json bajo el namespace "card".
 */
export const CONTACT = {
  firstName: "Nicolás",
  lastName: "Londoño",
  fullName: "Nicolás Londoño",
  initials: "NL",
  org: "MESAPAY",
  phoneE164: "+573001710907",
  phoneDisplay: "+57 300 171 0907",
  waDigits: "573001710907",
  email: "info@mesapay.co",
  site: "https://mesapay.co",
  siteDisplay: "mesapay.co",
  cardUrl: "https://mesapay.co/nicolas",
  cardUrlDisplay: "mesapay.co/nicolas",
} as const;
