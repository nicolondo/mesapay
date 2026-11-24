"use server";

import { signOut } from "@/auth";

/**
 * Acciones de cierre de sesión de las cabeceras del personal.
 *
 * Están en su propio archivo `"use server"` —y no como closure dentro del
 * componente compartido— a propósito: así son Server Functions exportadas sin
 * argumentos capturados. Un `signOut({ redirectTo })` con el destino tomado de
 * una prop obligaría a Next a cifrar ese valor dentro del action, y en un
 * despliegue blue/green una página servida por la versión vieja se enviaría a
 * la nueva con un cifrado que no puede descifrar: cerrar sesión fallaría justo
 * durante el cambio de color.
 */

/** Mesero, cocina y bar vuelven al login: son dispositivos de turno. */
export async function staffSignOut() {
  await signOut({ redirectTo: "/signin" });
}

/** El datáfono vuelve a la portada, como antes de unificar la cabecera. */
export async function terminalSignOut() {
  await signOut({ redirectTo: "/" });
}
