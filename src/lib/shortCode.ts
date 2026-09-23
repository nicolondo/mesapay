import { randomBytes } from "node:crypto";

/** 96 random bits; uniqueness is additionally enforced by PostgreSQL. */
export function shortCode(): string {
  return randomBytes(12).toString("hex").toUpperCase().match(/.{1,6}/g)!.join("-");
}

/**
 * Sólo presentación: el primer grupo (`002A77`) para humanos. El código
 * completo sigue siendo el identificador (URLs, tokens, búsquedas). La
 * implementación vive en `orderCode.ts` para que los componentes cliente
 * puedan importarla sin traer `node:crypto`.
 */
export { displayOrderCode } from "./orderCode";
